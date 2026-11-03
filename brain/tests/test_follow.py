# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Following an object across cameras (ADR 0070), on synthetic scenes built from fixture frames: a cardboard
box (no COCO class) carried across three "rooms" is found in order with the gap between, a different crate
moving at the same time is not taken for it, and a person is refused as a reference."""

import time
from pathlib import Path

import cv2
import numpy as np
import pytest

from senseplane_brain.detector import YoloxDetector
from senseplane_brain.follow import MAYBE, STRONG, Follower, ImageEmbedder, PersonRefused, Reference, crop
from senseplane_brain.vlm import Answer

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
W, H = 640, 360


def first_frame(name: str, at_s: float = 0.5) -> np.ndarray:
    cap = cv2.VideoCapture(str(FIXTURES / name))
    cap.set(cv2.CAP_PROP_POS_MSEC, at_s * 1000)
    ok, bgr = cap.read()
    cap.release()
    assert ok, name
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    s = max(W / w, H / h)
    rgb = cv2.resize(rgb, (round(w * s), round(h * s)))
    y, x = (rgb.shape[0] - H) // 2, (rgb.shape[1] - W) // 2
    return np.ascontiguousarray(rgb[y:y + H, x:x + W])


def cardboard_box(w: int, h: int, seed: int = 1) -> np.ndarray:
    """A brown box with a darker side, a lid line and red tape across it, with a little cardboard texture."""
    rng = np.random.default_rng(seed)
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = (168, 118, 70)
    img[:, int(w * 0.72):] = (128, 88, 50)  # the side in shade
    img[: int(h * 0.22)] = (186, 136, 86)  # the lid in light
    img[:, int(w * 0.33):int(w * 0.42)] = (200, 30, 35)  # tape over the top and down the front
    img[int(h * 0.18):int(h * 0.26), : int(w * 0.72)] = (200, 30, 35)
    noise = rng.integers(-12, 12, size=(h, w, 1))
    img = np.clip(img.astype(int) + noise, 0, 255).astype(np.uint8)
    cv2.rectangle(img, (0, 0), (w - 1, h - 1), (90, 60, 30), 2)
    return img


def crate(w: int, h: int) -> np.ndarray:
    """A grey-blue plastic crate with holes: box-shaped, but not the box."""
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = (70, 110, 150)
    for y in range(int(h * 0.2), h - 8, 14):
        for x in range(8, w - 12, 18):
            cv2.rectangle(img, (x, y), (x + 9, y + 6), (25, 35, 50), -1)
    cv2.rectangle(img, (0, 0), (w - 1, h - 1), (40, 60, 90), 3)
    return img


def place(bg: np.ndarray, sprite: np.ndarray, x: int, y: int, rng) -> tuple[np.ndarray, tuple]:
    f = bg.copy()
    h, w = sprite.shape[:2]
    f[y:y + h, x:x + w] = sprite
    f = np.clip(f.astype(int) + rng.integers(-3, 4, size=f.shape), 0, 255).astype(np.uint8)  # sensor noise
    return f, (float(x), float(y), float(x + w), float(y + h))


@pytest.fixture(scope="module")
def follower():
    return Follower(YoloxDetector("yolox_s_int8", score_threshold=0.3), ImageEmbedder())


@pytest.fixture(scope="module")
def scene():
    """Three cameras, a frame a second for 40 s. The box crosses A (0–9 s), is out of sight 10–24 s, crosses C (25–35 s);
    a crate moves around B the whole time."""
    rng = np.random.default_rng(7)
    rooms = {"a": first_frame("rain-window-night-640x360.mp4"), "b": first_frame("night-sky-empty-640x480.mp4"),
             "c": first_frame("storm-rain-night-360x640.mp4", 2)}
    box_a, box_c, other = cardboard_box(96, 72), cardboard_box(120, 90), crate(100, 76)
    cams: dict[str, list[tuple[float, np.ndarray, tuple | None]]] = {k: [] for k in rooms}
    for t in range(40):
        if t < 10:
            f, b = place(rooms["a"], box_a, 40 + t * 50, 200 - t * 4, rng)
            cams["a"].append((t, f, b))
        else:
            cams["a"].append((t, rooms["a"].copy(), None))
        f, _ = place(rooms["b"], other, 60 + (t * 37) % 420, 120 + (t * 11) % 150, rng)
        cams["b"].append((t, f, None))
        if 25 <= t <= 35:
            f, b = place(rooms["c"], box_c, 500 - (t - 25) * 40, 150 + (t - 25) * 5, rng)
            cams["c"].append((t, f, b))
        else:
            cams["c"].append((t, rooms["c"].copy(), None))
    return cams


def test_finds_the_box_in_order_with_the_gap(follower, scene):
    t0 = time.monotonic()
    _, frame, box = scene["a"][2]
    ref, calls = follower.reference(frame, box)
    assert calls == 0 and ref.label is None  # no model here, and no COCO class for a cardboard box
    seen: list[tuple[str, float, float]] = []
    for cam, frames in scene.items():
        sightings, _ = follower.scan(ref, [f for _, f, _ in frames], budget=0)
        for s in sightings:
            t, _, truth = frames[s.index]
            assert truth is not None, f"camera {cam} at {t}s: a sighting where the box isn't"
            assert max(abs(a - b) for a, b in zip(s.box, truth)) < 40, (cam, t, s.box, truth)
            seen.append((cam, t, s.confidence))
    seen.sort(key=lambda x: x[1])
    cams = [c for c, _, _ in seen]
    # In order: camera A, then C; never the crate on B.
    assert "b" not in cams
    assert cams == sorted(cams)
    a_times = [t for c, t, _ in seen if c == "a"]
    c_times = [t for c, t, _ in seen if c == "c"]
    assert len(a_times) >= 8 and len(c_times) >= 9  # found in most of the frames it is in
    assert max(a_times) <= 9 and min(c_times) >= 25  # so the gap 10–24 s is a gap
    elapsed = time.monotonic() - t0
    print(f"follow: {len(seen)} sightings in 120 frames, {elapsed:.1f} s on CPU")


def test_scores_separate_the_box_from_the_crate(follower, scene):
    _, frame, box = scene["a"][2]
    ref, _ = follower.reference(frame, box)
    same = [crop(f, b) for _, f, b in scene["c"] if b is not None]
    found = follower.candidates([f for _, f, _ in scene["b"][:12]])
    other = [crop(scene["b"][i][1], c) for i, cs in enumerate(found) for c in cs]
    assert len(other) >= 10  # the crate is a candidate in nearly every frame
    s_same, s_other = follower.score(ref, same), follower.score(ref, other)
    print(f"same box: {s_same.min():.3f}–{s_same.max():.3f}; crate: {s_other.min():.3f}–{s_other.max():.3f}")
    assert s_same.min() >= MAYBE
    assert s_other.max() < MAYBE


class _Model:
    """Answers the person question as told, and the same-object question by colour (a stand-in for a vision model)."""

    def __init__(self, person: bool = False):
        self.person = person
        self.calls = []

    def ask(self, rgb, question, meta=None, before=None):
        self.calls.append((question, meta))
        if "person" in question and "same" not in question:
            return Answer(self.person, "a person" if self.person else "a box", 0.9)
        return Answer(True, "the same", 0.9)


def test_refuses_a_person(follower):
    frame = first_frame("doorstep-parcel-640x360.mp4", 12)
    people = [d for d in follower.detector.detect(frame) if d.label == "person"]
    assert people, "the fixture has a person at 12 s"
    with pytest.raises(PersonRefused):
        follower.reference(frame, people[0].box)
    # A box around the person, and one on their middle, are refused too.
    x1, y1, x2, y2 = people[0].box
    with pytest.raises(PersonRefused):
        follower.reference(frame, (max(0, x1 - 30), max(0, y1 - 30), min(W, x2 + 30), min(H, y2 + 30)))
    with pytest.raises(PersonRefused):
        follower.reference(frame, (x1 + (x2 - x1) * 0.2, y1 + (y2 - y1) * 0.3, x2 - (x2 - x1) * 0.2, y2 - (y2 - y1) * 0.3))


def test_refuses_what_the_model_says_is_a_person(scene):
    model = _Model(person=True)
    f = Follower(YoloxDetector("yolox_s_int8", score_threshold=0.3), ImageEmbedder(), model)
    _, frame, box = scene["a"][2]
    with pytest.raises(PersonRefused):
        f.reference(frame, box, {"account": "acc"})
    assert model.calls[0][1]["purpose"] == "follow"


def test_close_calls_go_to_the_model_within_the_budget(scene):
    model = _Model()
    f = Follower(YoloxDetector("yolox_s_int8", score_threshold=0.3), ImageEmbedder(), model)
    _, frame, box = scene["a"][2]
    ref, calls = f.reference(frame, box, {"account": "acc"})
    assert calls == 1
    # A reference that matches only loosely (the box seen darker) makes every sighting a close call.
    dim = Reference(ref.vector, ref.colour * 0 + 1 / len(ref.colour), None, ref.crop)
    sightings, used = f.scan(dim, [fr for _, fr, _ in scene["c"]], budget=3, meta={"account": "acc"})
    assert used <= 3
    assert all(s.score < STRONG for s in sightings)
    assert sum(1 for s in sightings if s.confirmed) == used


def test_reference_round_trips(follower, scene):
    _, frame, box = scene["a"][2]
    ref, _ = follower.reference(frame, box)
    back = Reference.from_wire(ref.to_wire())
    assert np.allclose(back.vector, ref.vector, atol=1e-4)
    assert back.crop.shape[2] == 3


def test_through_the_worker_requests(follower, scene):
    """rpc.brain.follow_reference and follow_scan as the API sends them: JPEG frames, boxes as fractions of the frame."""
    from senseplane_brain.worker import Worker, encode_jpeg

    w = Worker("redis://localhost:1", "b", detector=follower.detector, sound=None, embedder=None, model=None)
    w._follower = follower
    w.configs["acc.cam"] = {"blur": {}}  # a camera the brain knows, not blurred
    b64 = lambda rgb: __import__("base64").b64encode(encode_jpeg(rgb)).decode()  # noqa: E731
    _, frame, (x1, y1, x2, y2) = scene["a"][2]
    out = w.do_follow_reference({"account_id": "acc", "source_id": "cam", "jpeg_b64": b64(frame), "box": [x1 / W, y1 / H, x2 / W, y2 / H]})
    assert "reference" in out and out["model_calls"] == 0
    scan = w.do_follow_scan({"account_id": "acc", "source_id": "cam", "reference": out["reference"], "budget": 2,
                             "frames": [{"t": f"2026-11-01T10:00:{t:02d}Z", "jpeg_b64": b64(f)} for t, f, _ in scene["c"][20:]]})
    assert scan["frames_examined"] == 20
    times = [s["t"] for s in scan["sightings"]]
    assert "2026-11-01T10:00:30Z" in times and "2026-11-01T10:00:39Z" not in times
    assert all(0 <= v <= 1 for s in scan["sightings"] for v in s["box"])
    person = first_frame("doorstep-parcel-640x360.mp4", 12)
    p = next(d for d in follower.detector.detect(person) if d.label == "person")
    px1, py1, px2, py2 = p.box
    assert w.do_follow_reference({"account_id": "acc", "source_id": "cam", "jpeg_b64": b64(person),
                                  "box": [px1 / W, py1 / H, px2 / W, py2 / H]}) == {"error": "person"}
    assert w.do_follow_scan({"account_id": "acc", "source_id": "cam", "description": "a box", "frames": []}) == {"error": "no_model"}
