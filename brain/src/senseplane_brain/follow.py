# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Following an object or a pet across cameras (ADR 0070): "how did this box
move through the house?". Never a person.

The API reads frames from the recordings (privacy masks already blacked
out) and sends them here a camera at a time; this finds the reference in them:

- Masks again, on each whole frame, before anything is cropped or compared:
  nothing behind a mask is looked at or reported.
- Candidates in each frame: YOLOX detections that are not people (a cat, a
  dog, a suitcase), and regions that differ from the camera's background
  (the median of the frames sent), for things YOLOX has no class for, like a
  cardboard box. People are found by a separate pass at a much lower score
  (0.12, boxes enlarged), and anything that overlaps one is dropped before it
  is embedded, so nothing here ever describes a person.
- Each candidate is compared with the reference: DINOv2-small (Meta, Apache
  2.0, int8 ONNX, 24 MB), which knows shape and texture but was trained to
  ignore colour, so a colour histogram counts too.
- Close calls go to the vision model ("is this the same object? if it is a
  person, no"), within the request's budget. Strong matches are checked for a
  person too: the low-score person pass on the crop, and the model on the
  first one of a batch when the budget allows.

The reference is checked first: a box on a person (the low-score pass), or one
the model says is a person, is refused. Nothing is kept: the reference's
vector goes back to the API for the next batch and is dropped when the follow
ends."""

from __future__ import annotations

import os
from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort

from . import models

Box = tuple[float, float, float, float]  # x1, y1, x2, y2 in frame pixels

# A candidate is the reference from STRONG; between MAYBE and STRONG the model decides (or, without one, it
# counts from UNCONFIRMED with its score as the confidence). Tuned on the synthetic tests and the fixtures.
STRONG = 0.82
MAYBE = 0.68
UNCONFIRMED = 0.76
# Appearance (DINOv2) and colour, weighted.
W_APPEARANCE = 0.6
W_COLOUR = 0.4
# The person pass: a much lower score than events use (a dim or half-hidden person still counts), boxes grown
# by this much per side, and a selection or candidate overlapping one this much (either way, or IoU) is a person.
PERSON_SCORE = 0.12
PERSON_GROW = 0.15
PERSON_OVERLAP = 0.3
# Candidates per frame, and the size range of a region that changed (fraction of the frame's area).
MAX_CANDIDATES = 8
MIN_AREA = 0.002
MAX_AREA = 0.4
DIFF_THRESHOLD = 28
MASKED_DROP = 0.5  # a candidate this much behind a privacy mask is never looked at
CROP_PAD = 0.0  # padding takes in the background, which differs from camera to camera
SIZE = 224
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
NOT_A_PERSON = " If what is shown is a person, or part of one, answer no."


class PersonRefused(Exception):
    """The reference is a person: following people is not something Senseplane does."""


def iou(a: Box, b: Box) -> float:
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def inside(a: Box, b: Box) -> float:
    """How much of `a` lies inside `b` (0..1)."""
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    area = (a[2] - a[0]) * (a[3] - a[1])
    return inter / area if area > 0 else 0.0


def is_person_box(box: Box, people: list[Box]) -> bool:
    """A selection or candidate that overlaps a person (it is one, is part of one, or holds one)."""
    return any(iou(box, p) >= PERSON_OVERLAP or inside(box, p) >= PERSON_OVERLAP or inside(p, box) >= PERSON_OVERLAP for p in people)


def grow(b: Box, w: int, h: int, by: float = PERSON_GROW) -> Box:
    dx, dy = (b[2] - b[0]) * by, (b[3] - b[1]) * by
    return (max(0.0, b[0] - dx), max(0.0, b[1] - dy), min(float(w), b[2] + dx), min(float(h), b[3] + dy))


def mask_frame(rgb: np.ndarray, polygons: list | None) -> tuple[np.ndarray, np.ndarray | None]:
    """The frame with its privacy masks (normalised polygons) black, at its own size, and the mask itself."""
    if not polygons:
        return rgb, None
    h, w = rgb.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    for poly in polygons:
        pts = np.array([[round(x * w), round(y * h)] for x, y in poly], np.int32)
        if len(pts) >= 3:
            cv2.fillPoly(mask, [pts], 1)
    out = rgb.copy()
    out[mask.astype(bool)] = 0
    return out, mask


def masked_share(box: Box, mask: np.ndarray | None) -> float:
    if mask is None:
        return 0.0
    x1, y1, x2, y2 = (int(v) for v in box)
    region = mask[max(0, y1):max(y1 + 1, y2), max(0, x1):max(x1 + 1, x2)]
    return float(region.mean()) if region.size else 0.0


def crop(rgb: np.ndarray, box: Box, pad: float = CROP_PAD) -> np.ndarray:
    h, w = rgb.shape[:2]
    x1, y1, x2, y2 = box
    px, py = (x2 - x1) * pad, (y2 - y1) * pad
    a, b = max(0, int(x1 - px)), max(0, int(y1 - py))
    c, d = min(w, int(np.ceil(x2 + px))), min(h, int(np.ceil(y2 + py)))
    return rgb[b:max(d, b + 1), a:max(c, a + 1)]


def colour_signature(rgb: np.ndarray) -> np.ndarray:
    """An HSV histogram (hue 12 × saturation 4 × value 4) of the middle of a crop (its edges are often background), summing to 1."""
    h, w = rgb.shape[:2]
    if h >= 10 and w >= 10:
        rgb = rgb[h // 10:h - h // 10, w // 10:w - w // 10]
    hsv = cv2.cvtColor(np.ascontiguousarray(rgb), cv2.COLOR_RGB2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [12, 4, 4], [0, 180, 0, 256, 0, 256]).flatten().astype(np.float32)
    s = float(hist.sum())
    return hist / s if s > 0 else hist


def colour_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Histogram intersection, 0..1."""
    return float(np.minimum(a, b).sum())


class ImageEmbedder:
    """DINOv2-small (int8 ONNX): the class token and the mean of the patch tokens, L2-normalised (768 dims)."""

    MODEL = "dinov2_small"

    def __init__(self):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = int(os.environ.get("FOLLOW_THREADS", "2"))
        self.session = ort.InferenceSession(str(models.fetch(self.MODEL)), opts, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name

    def embed(self, crops: list[np.ndarray]) -> np.ndarray:
        if not crops:
            return np.zeros((0, 768), dtype=np.float32)
        batch = np.stack([self._prep(c) for c in crops])
        out = []
        for i in range(0, len(batch), 16):
            hidden = self.session.run(None, {self.input: batch[i:i + 16]})[0]
            out.append(np.concatenate([hidden[:, 0], hidden[:, 1:].mean(1)], axis=1))
        v = np.concatenate(out).astype(np.float32)
        return v / np.clip(np.linalg.norm(v, axis=1, keepdims=True), 1e-9, None)

    @staticmethod
    def _prep(rgb: np.ndarray) -> np.ndarray:
        # Letterboxed to a square so a long object keeps its shape; padded grey like the normalised mean.
        h, w = rgb.shape[:2]
        s = SIZE / max(h, w)
        small = cv2.resize(rgb, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
        sq = np.full((SIZE, SIZE, 3), 124, dtype=np.uint8)
        y, x = (SIZE - small.shape[0]) // 2, (SIZE - small.shape[1]) // 2
        sq[y:y + small.shape[0], x:x + small.shape[1]] = small
        return ((sq.astype(np.float32) / 255.0 - MEAN) / STD).transpose(2, 0, 1)


@dataclass
class Reference:
    vector: np.ndarray
    colour: np.ndarray
    label: str | None  # the detector's class when it has one (cat, dog, suitcase), else None
    crop: np.ndarray  # for the model's same-object question; never stored

    def to_wire(self) -> dict:
        ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(self.crop, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])
        import base64

        return {"vector": self.vector.round(5).tolist(), "colour": self.colour.round(6).tolist(), "label": self.label,
                "crop_jpeg_b64": base64.b64encode(jpg.tobytes()).decode() if ok else None}

    @staticmethod
    def from_wire(d: dict) -> "Reference":
        import base64

        crop_rgb = None
        if d.get("crop_jpeg_b64"):
            bgr = cv2.imdecode(np.frombuffer(base64.b64decode(d["crop_jpeg_b64"]), np.uint8), cv2.IMREAD_COLOR)
            crop_rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB) if bgr is not None else None
        return Reference(np.asarray(d["vector"], dtype=np.float32), np.asarray(d["colour"], dtype=np.float32), d.get("label"),
                         crop_rgb if crop_rgb is not None else np.zeros((8, 8, 3), np.uint8))


@dataclass
class Sighting:
    index: int  # the frame's index in the batch
    box: Box
    score: float
    confidence: float
    confirmed: bool | None  # True: the model said it is the same; None: not asked


class Follower:
    """Finds a reference in frames. `detector` is YOLOX (detect(rgb, score_threshold) → Detection list), `model` the
    vision model client or None, `embedder` an ImageEmbedder. `redact(rgb)` blurs a whole frame as its camera asks
    before any of it goes to the model; `masks` are the camera's privacy masks."""

    def __init__(self, detector, embedder: ImageEmbedder, model=None):
        self.detector, self.embedder, self.model = detector, embedder, model

    # --- people -------------------------------------------------------------------
    def detect_low(self, rgb: np.ndarray) -> list:
        """One detector pass at the person guard's low score."""
        try:
            return self.detector.detect(rgb, score_threshold=PERSON_SCORE)
        except TypeError:  # a detector without the override
            return self.detector.detect(rgb)

    def people(self, rgb: np.ndarray, dets: list | None = None) -> list[Box]:
        """Every person the detector sees even faintly, boxes grown: the guard's view, not an event's."""
        h, w = rgb.shape[:2]
        return [grow(d.box, w, h) for d in (self.detect_low(rgb) if dets is None else dets) if d.label == "person"]

    def crop_has_person(self, c: np.ndarray) -> bool:
        """A crop that shows a person (looked at larger, so a small one is still seen)."""
        if c.size == 0:
            return False
        s = max(1.0, 320.0 / max(c.shape[:2]))
        big = cv2.resize(c, (round(c.shape[1] * s), round(c.shape[0] * s))) if s > 1 else c
        h, w = big.shape[:2]
        return any(inside(p, (0, 0, w, h)) * (p[2] - p[0]) * (p[3] - p[1]) >= PERSON_OVERLAP * w * h for p in self.people(big))

    def _model_says_person(self, c: np.ndarray, meta: dict | None) -> bool:
        a = self.model.ask(c, "Is the main thing in this picture a person, or part of a person (a face, a hand, a body)?", {**(meta or {}), "purpose": "follow"})
        return a.yes is True

    # --- the reference ------------------------------------------------------------
    def reference(self, rgb: np.ndarray, box: Box, meta: dict | None = None, redact=None, ask_model: bool = True,
                  masks: list | None = None) -> tuple[Reference, int]:
        """The reference from a box on a frame. Raises PersonRefused for a person. Returns it and the model calls used."""
        rgb, _ = mask_frame(rgb, masks)
        h, w = rgb.shape[:2]
        x1, y1, x2, y2 = max(0.0, box[0]), max(0.0, box[1]), min(float(w), box[2]), min(float(h), box[3])
        if x2 - x1 < 4 or y2 - y1 < 4:
            raise ValueError("the box is too small")
        box = (x1, y1, x2, y2)
        if is_person_box(box, self.people(rgb)):
            raise PersonRefused("the selection is a person")
        label = None
        best = 0.0
        for d in self.detector.detect(rgb):
            if d.label != "person" and iou(box, d.box) > max(0.5, best):
                label, best = d.label, iou(box, d.box)
        c = crop(rgb, box)
        if self.crop_has_person(c):
            raise PersonRefused("the selection shows a person")
        # Blurred as a whole frame (faces and masks are found in context), then cropped: what goes to the model.
        shown = crop(redact(rgb), box) if redact else c
        calls = 0
        if self.model is not None and ask_model:
            calls += 1
            if self._model_says_person(shown, meta):
                raise PersonRefused("the model says the selection is a person")
        vec = self.embedder.embed([c])[0]
        # The crop only ever goes to the model (and back through the API to the next batch): blurred like any frame that leaves.
        return Reference(vec, colour_signature(c), label, shown), calls

    def find_described(self, frames: list[np.ndarray], description: str, budget: int, meta: dict | None = None,
                       redact=None, person_check: bool = True, masks: list | None = None) -> tuple[Reference | None, int, int]:
        """The first candidate the model says matches a description, as the reference (index of its frame, model calls).
        Candidates are never people (see candidates), and with `person_check` a match is asked again whether it is one."""
        if self.model is None:
            raise RuntimeError("no_model")
        frames = [mask_frame(f, masks)[0] for f in frames]
        calls = 0
        cands = self.candidates(frames)
        # Bigger changes first: likelier the thing someone means.
        order = sorted(((i, b) for i, bs in enumerate(cands) for b in bs), key=lambda x: -((x[1][2] - x[1][0]) * (x[1][3] - x[1][1])))
        shown_frames: dict[int, np.ndarray] = {}
        for i, b in order:
            if calls >= budget:
                break
            if i not in shown_frames:
                shown_frames[i] = redact(frames[i]) if redact else frames[i]
            c, shown = crop(frames[i], b), crop(shown_frames[i], b)
            calls += 1
            a = self.model.ask(shown, f"Does this picture show {description}?{NOT_A_PERSON}", {**(meta or {}), "purpose": "follow"})
            if a.yes is not True:
                continue
            if person_check:
                if calls >= budget:
                    break
                calls += 1
                if self._model_says_person(shown, meta):
                    continue
            return Reference(self.embedder.embed([c])[0], colour_signature(c), None, shown), i, calls
        return None, -1, calls

    # --- candidates -------------------------------------------------------------------
    def candidates(self, frames: list[np.ndarray], masks: list[np.ndarray | None] | None = None) -> list[list[Box]]:
        """Per frame: boxes of non-person detections and of regions that changed against the background, with every
        box that overlaps a person (the low-score pass) or sits behind a mask left out."""
        if not frames:
            return []
        h, w = frames[0].shape[:2]
        scale = 240.0 / max(h, w)
        small = [cv2.GaussianBlur(cv2.resize(f, (max(1, round(f.shape[1] * scale)), max(1, round(f.shape[0] * scale)))), (5, 5), 0) for f in frames]
        same_size = all(s.shape == small[0].shape for s in small)
        background = np.median(np.stack(small), axis=0).astype(np.uint8) if same_size and len(small) >= 3 else None
        out: list[list[Box]] = []
        for k, (f, s) in enumerate(zip(frames, small)):
            dets = self.detect_low(f)
            people = self.people(f, dets)
            # Things at the detector's own score; people at the guard's.
            floor = getattr(self.detector, "score_threshold", 0.4)
            boxes: list[Box] = [d.box for d in dets if d.label != "person" and d.score >= floor]
            if background is not None and s.shape == background.shape:
                diff = cv2.absdiff(s, background).max(axis=2)
                mask = (diff > DIFF_THRESHOLD).astype(np.uint8) * 255
                mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
                mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
                n, _, stats, _ = cv2.connectedComponentsWithStats(mask)
                fh, fw = f.shape[:2]
                for j in range(1, n):
                    x, y, bw, bh, _area = stats[j]
                    frac = (bw * bh) / float(mask.shape[0] * mask.shape[1])
                    if MIN_AREA <= frac <= MAX_AREA:
                        boxes.append((x / scale, y / scale, min(fw, (x + bw) / scale), min(fh, (y + bh) / scale)))
            privacy = masks[k] if masks else None
            kept: list[Box] = []
            for b in sorted(boxes, key=lambda b: -(b[2] - b[0]) * (b[3] - b[1])):
                if is_person_box(b, people) or masked_share(b, privacy) >= MASKED_DROP or any(iou(b, x) > 0.6 for x in kept):
                    continue
                kept.append(b)
            out.append(kept[:MAX_CANDIDATES])
        return out

    # --- matching ---------------------------------------------------------------------
    def score(self, ref: Reference, crops: list[np.ndarray]) -> np.ndarray:
        if not crops:
            return np.zeros(0, dtype=np.float32)
        vecs = self.embedder.embed(crops)
        appearance = vecs @ ref.vector
        colour = np.array([colour_similarity(ref.colour, colour_signature(c)) for c in crops], dtype=np.float32)
        return W_APPEARANCE * appearance + W_COLOUR * colour

    def scan(self, ref: Reference, frames: list[np.ndarray], budget: int, meta: dict | None = None,
             redact=None, masks: list | None = None) -> tuple[list[Sighting], int]:
        """The best match per frame, if any, and the model calls used."""
        masked = [mask_frame(f, masks) for f in frames]
        frames = [m[0] for m in masked]
        cands = self.candidates(frames, [m[1] for m in masked])
        flat = [(i, b) for i, bs in enumerate(cands) for b in bs]
        scores = self.score(ref, [crop(frames[i], b) for i, b in flat])
        best: dict[int, tuple[Box, float]] = {}
        for (i, b), s in zip(flat, scores.tolist()):
            if s >= MAYBE and s > best.get(i, ((0, 0, 0, 0), -1.0))[1]:
                best[i] = (b, s)
        calls = 0
        out: list[Sighting] = []
        shown_cache: dict[int, np.ndarray] = {}

        def shown(i: int, b: Box) -> np.ndarray:
            if i not in shown_cache:
                shown_cache[i] = redact(frames[i]) if redact else frames[i]
            return crop(shown_cache[i], b)

        strong_checked = False
        for i in sorted(best):
            b, s = best[i]
            if self.crop_has_person(crop(frames[i], b)):
                continue
            if s >= STRONG:
                # The first strong match of a batch is asked about a person too, when the budget allows.
                if self.model is not None and not strong_checked and calls < budget:
                    strong_checked = True
                    calls += 1
                    if self._model_says_person(shown(i, b), meta):
                        continue
                out.append(Sighting(i, b, s, min(0.99, s), None))
                continue
            if self.model is not None and calls < budget:
                calls += 1
                a = self.model.ask(_side_by_side(ref.crop, shown(i, b)),
                                   "The left half shows an object or animal. Is the thing in the right half the same individual "
                                   f"object or animal (not just the same kind of thing)?{NOT_A_PERSON}", {**(meta or {}), "purpose": "follow"})
                if a.yes is True:
                    out.append(Sighting(i, b, s, max(s, min(0.95, a.confidence or 0.85)), True))
                continue
            if s >= UNCONFIRMED:
                out.append(Sighting(i, b, s, s * 0.9, None))
        return out, calls


def _side_by_side(a: np.ndarray, b: np.ndarray, h: int = 256) -> np.ndarray:
    def fit(x):
        s = h / x.shape[0]
        return cv2.resize(x, (max(1, round(x.shape[1] * s)), h))

    left, right = fit(a), fit(b)
    gap = np.full((h, 8, 3), 255, dtype=np.uint8)
    return np.concatenate([left, gap, right], axis=1)
