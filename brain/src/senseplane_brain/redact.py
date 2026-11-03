# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Privacy blurring (ADR 0068): faces and number plates are pixelated in every
frame that leaves the brain: what goes to a model (watch checks, look, ask,
chat) and every snapshot.

Detection only, to know where to blur: nothing here recognises anyone, and no
face crop, box or embedding is kept or sent anywhere. The detectors run only
on frames on their way out, not on every analysed frame.

Faces: YuNet (OpenCV Zoo, MIT) through ONNX Runtime. To err towards blurring
too much, the top of every tracked person's box is blurred too when no face
was found in it (a face turned away, under a cap or too small), and every box
is padded well beyond the face.

Plates: LPD-YuNet (OpenCV Zoo, Apache 2.0), on the frame and on each tracked
vehicle. It was trained on Chinese plates, so it is a best effort elsewhere;
ADR 0068 has the plan to train a plate class into our own YOLOX."""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass

import cv2
import numpy as np

from . import models

Box = tuple[float, float, float, float]  # x1, y1, x2, y2 in frame pixels

# A face counts from this score. Low on purpose: a missed face is the failure
# that matters, a blurred patch of wall costs nothing.
FACE_SCORE = 0.3
FACE_NMS = 0.3
# Faces near the model's floor (about 10 px) are found by looking at the frame
# this much larger; above UPSCALE_BELOW pixels on the long side it is not upscaled.
FACE_UPSCALE = 1.5
UPSCALE_BELOW = 960
# Padding around a face box, as a fraction of its size per side (hair, ears, a
# beard, a box that is a little off), and pixelation cells across the padded box.
FACE_PAD = 0.35
CELLS = 6
# Head fallback: the top of a person's box, as a fraction of its height (and at
# least as tall as it is wide times this), when no face was found inside it.
HEAD_FRACTION = 0.28
HEAD_MIN_ASPECT = 0.9
# Plates: low for the same reason; a plate box grows by this much per side.
PLATE_SCORE = 0.5
PLATE_PAD = 0.25
MAX_VEHICLES = 4  # vehicle crops looked at per frame, largest first


@dataclass(frozen=True)
class Blur:
    """What to blur in one frame."""

    faces: bool = False
    plates: bool = False

    def __bool__(self) -> bool:
        return self.faces or self.plates

    def __or__(self, other: Blur) -> Blur:
        return Blur(self.faces or other.faces, self.plates or other.plates)

    @staticmethod
    def of(cfg: dict | None) -> Blur:
        """From a source config's or a request's `blur` ({faces, plates}, spec/brain/valkey.json)."""
        b = (cfg or {}).get("blur") or {}
        return Blur(bool(b.get("faces")), bool(b.get("plates")))


class FaceDetector:
    """YuNet face detection (boxes only; the landmarks it also outputs are ignored)."""

    def __init__(self, score_threshold: float = FACE_SCORE, nms_threshold: float = FACE_NMS, upscale: float = FACE_UPSCALE):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = int(os.environ.get("DETECTOR_THREADS", "2"))
        self.session = ort.InferenceSession(str(models.fetch("yunet")), opts, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.outputs = [o.name for o in self.session.get_outputs()]
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        self.upscale = upscale

    def detect(self, rgb: np.ndarray) -> list[tuple[Box, float]]:
        h, w = rgb.shape[:2]
        scale = self.upscale if max(h, w) < UPSCALE_BELOW else 1.0
        img = cv2.resize(rgb, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_LINEAR) if scale != 1.0 else rgb
        ih, iw = img.shape[:2]
        # The model wants BGR 0-255 in a size divisible by its largest stride (32).
        ph, pw = -(-ih // 32) * 32, -(-iw // 32) * 32
        padded = np.zeros((ph, pw, 3), dtype=np.uint8)
        padded[:ih, :iw] = img[:, :, ::-1]
        blob = np.ascontiguousarray(padded.transpose(2, 0, 1), dtype=np.float32)[None]
        out = dict(zip(self.outputs, self.session.run(self.outputs, {self.input_name: blob}), strict=True))
        boxes, scores = [], []
        for stride in (8, 16, 32):
            cols = pw // stride
            cls = np.clip(out[f"cls_{stride}"][0, :, 0], 0, 1)
            obj = np.clip(out[f"obj_{stride}"][0, :, 0], 0, 1)
            score = np.sqrt(cls * obj)
            keep = np.where(score >= self.score_threshold)[0]
            if not len(keep):
                continue
            bb = out[f"bbox_{stride}"][0, keep]
            r, c = keep // cols, keep % cols
            cx, cy = (c + bb[:, 0]) * stride, (r + bb[:, 1]) * stride
            bw, bh = np.exp(bb[:, 2]) * stride, np.exp(bb[:, 3]) * stride
            for i in range(len(keep)):
                boxes.append([float(cx[i] - bw[i] / 2) / scale, float(cy[i] - bh[i] / 2) / scale, float(bw[i]) / scale, float(bh[i]) / scale])
                scores.append(float(score[keep[i]]))
        if not boxes:
            return []
        kept = np.array(cv2.dnn.NMSBoxes(boxes, scores, self.score_threshold, self.nms_threshold)).flatten()
        return [((max(0.0, boxes[k][0]), max(0.0, boxes[k][1]), min(float(w), boxes[k][0] + boxes[k][2]), min(float(h), boxes[k][1] + boxes[k][3])), scores[k])
                for k in kept]


class PlateDetector:
    """LPD-YuNet (OpenCV Zoo, Apache 2.0) for number plates, through OpenCV's DNN module, which runs it at
    the frame's own size (its ONNX file has a fixed 320x240 input that ONNX Runtime would hold it to, too
    small for a plate across a driveway). It looks at the whole frame and, enlarged, at each vehicle the
    tracker follows. It was trained on Chinese plates: others are found less reliably (ADR 0068)."""

    MIN_SIZES = ([10, 16, 24], [32, 48], [64, 96], [128, 192, 256])
    STEPS = (8, 16, 32, 64)
    VARIANCE = 0.1
    CROP_SIDE = 480  # a vehicle crop is resized to this on its long side

    def __init__(self, score_threshold: float = PLATE_SCORE, nms_threshold: float = 0.3):
        self.net = cv2.dnn.readNet(str(models.fetch("lpd_yunet")))
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        self._priors: dict[tuple[int, int], np.ndarray] = {}

    def priors(self, w: int, h: int) -> np.ndarray:
        if (w, h) not in self._priors:
            fh, fw = (h + 1) // 2 // 2, (w + 1) // 2 // 2
            out = []
            for k, sizes in enumerate(self.MIN_SIZES):
                fh, fw = fh // 2, fw // 2
                for i in range(fh):
                    for j in range(fw):
                        for s in sizes:
                            out.append([(j + 0.5) * self.STEPS[k] / w, (i + 0.5) * self.STEPS[k] / h, s / w, s / h])
            if len(self._priors) > 16:
                self._priors.clear()
            self._priors[(w, h)] = np.array(out, dtype=np.float32)
        return self._priors[(w, h)]

    def _run(self, rgb: np.ndarray) -> list[tuple[Box, float]]:
        """Plates in one image, in its pixels. The image is padded (right and bottom, so pixels keep their
        place) to a multiple of the net's largest stride, so its outputs line up with the priors."""
        h, w = rgb.shape[:2]
        ph, pw = -(-h // 64) * 64, -(-w // 64) * 64
        padded = np.zeros((ph, pw, 3), dtype=np.uint8)
        padded[:h, :w] = rgb[:, :, ::-1]  # BGR, 0-255
        self.net.setInput(cv2.dnn.blobFromImage(padded))
        loc, conf, iou = self.net.forward(["loc", "conf", "iou"])
        priors = self.priors(pw, ph)
        if len(priors) != len(loc):
            raise RuntimeError(f"plate model gave {len(loc)} rows for {pw}x{ph}, priors are {len(priors)}")
        ow, oh = w, h
        w, h = pw, ph  # boxes come out in the padded image's pixels, the same as the original's
        scores = np.sqrt(np.clip(conf[:, 1], 0, 1) * np.clip(iou[:, 0], 0, 1))
        keep = np.where(scores >= self.score_threshold)[0]
        if not len(keep):
            return []
        p, lc = priors[keep], loc[keep]
        # The plate's four corners (it may be at an angle); its upright bounding box is what gets blurred.
        corners = np.stack([p[:, 0:2] + lc[:, o:o + 2] * self.VARIANCE * p[:, 2:4] for o in (4, 6, 10, 12)], 1) * (w, h)
        x1, y1 = corners[:, :, 0].min(1), corners[:, :, 1].min(1)
        x2, y2 = corners[:, :, 0].max(1), corners[:, :, 1].max(1)
        boxes = [[float(a), float(b), float(c - a), float(d - b)] for a, b, c, d in zip(x1, y1, x2, y2, strict=True)]
        kept = np.array(cv2.dnn.NMSBoxes(boxes, scores[keep].tolist(), self.score_threshold, self.nms_threshold)).flatten()
        # A "plate" over half the picture is the model misreading a close-up, not a plate.
        return [((boxes[k][0], boxes[k][1], boxes[k][0] + boxes[k][2], boxes[k][1] + boxes[k][3]), float(scores[keep][k])) for k in kept
                if boxes[k][2] < ow * 0.5 and boxes[k][3] < oh * 0.5]

    def detect(self, rgb: np.ndarray, vehicles: list[Box] | None = None) -> list[tuple[Box, float]]:
        """Plates in the frame. With vehicles the tracker follows, on each of them, enlarged. Otherwise (none
        tracked, a stored snapshot, a frame from another moment) the whole frame: a parked car the tracker
        has dropped, or a frame no tracks belong to, still gets looked at (about 40 ms at 640x360)."""
        h, w = rgb.shape[:2]
        if not vehicles:
            found = self._run(rgb)
        else:
            found = []
            for v in sorted(vehicles, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)[:MAX_VEHICLES]:
                # A little beyond the vehicle's box: a plate on a bumper sits at its edge.
                pw, ph = (v[2] - v[0]) * 0.05, (v[3] - v[1]) * 0.05
                x1, y1, x2, y2 = int(max(0, v[0] - pw)), int(max(0, v[1] - ph)), int(min(w, v[2] + pw)), int(min(h, v[3] + ph))
                if x2 - x1 < 16 or y2 - y1 < 16:
                    continue
                s = self.CROP_SIDE / max(x2 - x1, y2 - y1)
                cw, ch = max(32, round((x2 - x1) * s)), max(32, round((y2 - y1) * s))
                sx, sy = cw / (x2 - x1), ch / (y2 - y1)
                crop = cv2.resize(rgb[y1:y2, x1:x2], (cw, ch), interpolation=cv2.INTER_LINEAR)
                found += [((b[0] / sx + x1, b[1] / sy + y1, b[2] / sx + x1, b[3] / sy + y1), sc) for b, sc in self._run(crop)]
        return [((max(0.0, b[0]), max(0.0, b[1]), min(float(w), b[2]), min(float(h), b[3])), s) for b, s in found]


def pixelate(rgb: np.ndarray, box: Box, cells: int = CELLS) -> None:
    """Pixelates a box in place: a few large cells, then smoothed, so nothing of a face's shape is left."""
    h, w = rgb.shape[:2]
    x1, y1, x2, y2 = max(0, int(box[0])), max(0, int(box[1])), min(w, int(np.ceil(box[2]))), min(h, int(np.ceil(box[3])))
    if x2 - x1 < 2 or y2 - y1 < 2:
        return
    roi = rgb[y1:y2, x1:x2]
    bw, bh = x2 - x1, y2 - y1
    nx = max(1, min(cells, bw))
    ny = max(1, min(cells, round(cells * bh / bw) or 1, bh))
    small = cv2.resize(roi, (nx, ny), interpolation=cv2.INTER_AREA)
    big = cv2.resize(small, (bw, bh), interpolation=cv2.INTER_NEAREST)
    k = max(3, (min(bw, bh) // 4) | 1)
    rgb[y1:y2, x1:x2] = cv2.GaussianBlur(big, (k, k), 0)


def pad(box: Box, frac: float, w: int, h: int) -> Box:
    bw, bh = box[2] - box[0], box[3] - box[1]
    return (max(0.0, box[0] - bw * frac), max(0.0, box[1] - bh * frac), min(float(w), box[2] + bw * frac), min(float(h), box[3] + bh * frac))


def head_of(person: Box) -> Box:
    """Where a person's head is likely to be: the top of their box, at least about as tall as it is wide."""
    x1, y1, x2, y2 = person
    pw, ph = x2 - x1, y2 - y1
    hh = min(ph, max(ph * HEAD_FRACTION, min(pw, ph * 0.5) * HEAD_MIN_ASPECT))
    return (x1, y1, x2, y1 + hh)


def _inside(face: Box, person: Box) -> bool:
    cx, cy = (face[0] + face[2]) / 2, (face[1] + face[3]) / 2
    return person[0] <= cx <= person[2] and person[1] <= cy <= person[3]


class Redactor:
    """Blurs faces and plates in a copy of a frame. The models load on first use, so a brain whose
    cameras never ask for blurring never loads them."""

    def __init__(self, faces: FaceDetector | None = None, plates: PlateDetector | None = None):
        self._faces = faces
        self._plates = plates
        # One lock per model: a session (ONNX Runtime, OpenCV DNN) runs one frame at a time. Loading has
        # its own lock, so a thread waiting to detect never waits behind a download.
        self._face_lock, self._plate_lock, self._load_lock = threading.Lock(), threading.Lock(), threading.Lock()

    @property
    def faces(self) -> FaceDetector:
        if self._faces is None:
            with self._load_lock:
                if self._faces is None:
                    self._faces = FaceDetector()
        return self._faces

    @property
    def plates(self) -> PlateDetector:
        if self._plates is None:
            with self._load_lock:
                if self._plates is None:
                    self._plates = PlateDetector()
        return self._plates

    def preload(self, blur: Blur) -> None:
        """Loads (and on first use downloads) the models a setting needs; the worker calls it in a thread
        as soon as a camera's config asks for blurring, so no frame waits for it."""
        if blur.faces:
            _ = self.faces
        if blur.plates:
            _ = self.plates

    def boxes(self, rgb: np.ndarray, blur: Blur, people: list[Box] | None = None, vehicles: list[Box] | None = None) -> list[Box]:
        """The regions to blur: padded faces, the heads of people without a face found, padded plates."""
        h, w = rgb.shape[:2]
        out: list[Box] = []
        if blur.faces:
            faces_model = self.faces
            with self._face_lock:
                faces = [b for b, _ in faces_model.detect(rgb)]
            out += [pad(b, FACE_PAD, w, h) for b in faces]
            for p in people or []:
                if not any(_inside(f, p) for f in faces):
                    out.append(pad(head_of(p), 0.1, w, h))
        if blur.plates:
            plates_model = self.plates
            with self._plate_lock:
                plates = plates_model.detect(rgb, vehicles)
            out += [pad(b, PLATE_PAD, w, h) for b, _ in plates]
        return out

    def apply(self, rgb: np.ndarray, blur: Blur, people: list[Box] | None = None, vehicles: list[Box] | None = None,
              masks: list | None = None) -> np.ndarray:
        """A blurred copy of the frame, or the frame itself when there is nothing to blur. `masks` are the
        camera's privacy masks (normalised polygons): they stay black, since pixelating across a mask's
        edge would grey it. Only they do: dark pixels elsewhere (a face at night) are blurred like any other."""
        if not blur:
            return rgb
        regions = self.boxes(rgb, blur, people, vehicles)
        if not regions:
            return rgb
        out = rgb.copy()
        for b in regions:
            pixelate(out, b)
        if masks:
            out[mask_pixels(masks, rgb.shape[1], rgb.shape[0])] = 0
        return out


def mask_pixels(masks: list, w: int, h: int) -> np.ndarray:
    """Privacy masks (polygons, [x, y] in 0-1, as the API rasterises them) as a boolean pixel mask."""
    m = np.zeros((h, w), dtype=np.uint8)
    for poly in masks:
        pts = np.array([[x * w, y * h] for x, y in poly], dtype=np.float64)
        if len(pts) >= 3:
            cv2.fillPoly(m, [np.round(pts).astype(np.int32)], 1)
    return m.astype(bool)
