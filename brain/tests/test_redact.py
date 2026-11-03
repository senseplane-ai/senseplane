# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Privacy blurring (ADR 0068): what leaves the brain is blurred when the source or the caller asks for it,
and untouched when nobody does; privacy masks stay black."""
import asyncio
import base64
import threading
import time

import cv2
import numpy as np
import pytest

from senseplane_brain import models
from senseplane_brain.pipeline import SourcePipeline
from senseplane_brain.redact import Blur, Redactor, head_of, pixelate
from senseplane_brain.vlm import Answer
from senseplane_brain.watches import Fire, WatchEngine
from senseplane_brain.worker import Worker, decode_jpeg, encode_jpeg

FACE = (300.0, 100.0, 340.0, 150.0)
PLATE = (100.0, 250.0, 160.0, 270.0)


class _Faces:
    def __init__(self):
        self.calls = 0

    def detect(self, _rgb):
        self.calls += 1
        return [(FACE, 0.9)]


class _Plates:
    """Records which vehicles it was given: None means "no tracks known", so the whole frame is looked at."""

    def __init__(self):
        self.vehicles: list = []

    def detect(self, _rgb, vehicles=None):
        self.vehicles.append(vehicles)
        return [(PLATE, 0.8)]


MASK = [[[0.0, 0.0], [40 / 640, 0.0], [40 / 640, 1.0], [0.0, 1.0]]]  # the left 40 px, as the API draws it


def _scene() -> np.ndarray:
    # Smooth texture with detail at the scale of a face, so JPEG keeps it and pixelation visibly removes it.
    rng = np.random.default_rng(1)
    rgb = cv2.resize(rng.integers(30, 255, size=(72, 128, 3), dtype=np.uint8), (640, 360), interpolation=cv2.INTER_CUBIC)
    rgb[:, :40] = 0  # a privacy mask, blacked out by the API
    return rgb


def _region(rgb, box):
    x1, y1, x2, y2 = (int(v) for v in box)
    return rgb[y1:y2, x1:x2]


def _changed(a, b, box) -> bool:
    return not np.array_equal(_region(a, box), _region(b, box))


def test_blur_settings_combine_and_default_off():
    assert not Blur() and not Blur.of(None) and not Blur.of({"zones": []})
    assert Blur.of({"blur": {"faces": True}}) == Blur(faces=True)
    assert Blur(faces=True) | Blur(plates=True) == Blur(True, True)


def test_nothing_is_touched_when_blurring_is_off():
    faces = _Faces()
    r = Redactor(faces, _Plates())
    rgb = _scene()
    assert r.apply(rgb, Blur()) is rgb
    assert faces.calls == 0  # the detector does not even run


def test_faces_and_plates_are_pixelated_and_the_rest_is_not():
    r = Redactor(_Faces(), _Plates())
    rgb = _scene()
    out = r.apply(rgb, Blur(faces=True, plates=True))
    assert out is not rgb and np.array_equal(rgb, _scene())  # a copy; the original frame is kept as it was
    assert _changed(rgb, out, FACE) and _changed(rgb, out, PLATE)
    assert np.array_equal(out[:50, 400:], rgb[:50, 400:])  # far from both
    # Strong: a pixelated face keeps almost none of its detail (edges from pixel to pixel).
    def detail(a):
        return float(np.abs(np.diff(_region(a, FACE).astype(float), axis=1)).mean())

    assert detail(out) < 0.25 * detail(rgb)


def test_only_what_was_asked_for_is_blurred():
    r = Redactor(_Faces(), _Plates())
    rgb = _scene()
    out = r.apply(rgb, Blur(faces=True))
    assert _changed(rgb, out, FACE) and not _changed(rgb, out, PLATE)


def test_the_face_box_is_padded():
    r = Redactor(_Faces(), _Plates())
    rgb = _scene()
    out = r.apply(rgb, Blur(faces=True))
    assert _changed(rgb, out, (FACE[0] - 12, FACE[1] - 15, FACE[0] - 2, FACE[1] - 2))  # beyond the box itself


def test_a_person_without_a_face_found_has_their_head_blurred():
    class NoFaces:
        def detect(self, _rgb):
            return []

    r = Redactor(NoFaces(), _Plates())
    rgb = _scene()
    person = (450.0, 60.0, 530.0, 330.0)
    out = r.apply(rgb, Blur(faces=True), people=[person])
    head = head_of(person)
    assert _changed(rgb, out, head)
    assert np.array_equal(_region(out, (450, 260, 530, 330)), _region(rgb, (450, 260, 530, 330)))  # legs untouched


def test_masks_stay_black():
    class EdgeFace:
        def detect(self, _rgb):
            return [((20.0, 100.0, 80.0, 160.0), 0.9)]  # across the mask's edge

    out = Redactor(EdgeFace(), _Plates()).apply(_scene(), Blur(faces=True), masks=MASK)
    assert not out[:, :40].any()
    assert out[100:160, 41:80].any()  # outside the mask, blurred


def test_a_dark_face_is_blurred_not_restored():
    # At night (IR, a dark room) a face can have pure black pixels; only the privacy masks are put back black.
    rgb = _scene()
    x1, y1, x2, y2 = (int(v) for v in FACE)
    rgb[y1:y2, x1:x2] = 0
    rgb[y1 + 10:y1 + 20, x1 + 5:x1 + 15] = 200  # an eye catching the light
    rgb[y1 + 10:y1 + 20, x2 - 15:x2 - 5] = 200
    out = Redactor(_Faces(), _Plates()).apply(rgb, Blur(faces=True), masks=MASK)
    face, was_black = _region(out, FACE), (_region(rgb, FACE) == 0).all(axis=2)
    # The old rule (every pure-black pixel put back) left the black silhouette with the eyes blurred inside.
    assert (face[was_black] > 0).any(axis=1).mean() > 0.3
    assert _region(out, (x1 + 5, y1 + 10, x1 + 15, y1 + 20)).max() < 200
    assert not out[:, :40].any()


def test_lpd_priors_match_small_and_thin_crops():
    from senseplane_brain.redact import PlateDetector

    pd = PlateDetector(score_threshold=0.0)  # every row kept: a prior missing for any row would fail
    rng = np.random.default_rng(3)
    for h, w in [(32, 480), (60, 480), (480, 32), (17, 33), (360, 640)]:
        for (x1, y1, x2, y2), _ in pd._run(rng.integers(0, 255, size=(h, w, 3), dtype=np.uint8)):
            assert x1 < x2 and y1 < y2


def test_pixelate_handles_tiny_and_edge_boxes():
    rgb = _scene()
    pixelate(rgb, (639.0, 359.0, 640.0, 360.0))
    pixelate(rgb, (-10.0, -10.0, 5.0, 5.0))
    pixelate(rgb, (600.0, 300.0, 700.0, 400.0))


# --- the worker: model inputs and snapshots ------------------------------------------------------------
class _Model:
    def __init__(self):
        self.frames = []
        self.metas = []

    def ask(self, rgb, _q, _meta=None, before=None):
        self.frames.append(rgb)
        self.metas.append(_meta)
        return Answer(answer="ok", yes=True, confidence=0.9)

    def describe(self, rgb, _meta=None):
        self.frames.append(rgb)
        return Answer(answer="ok", yes=None, confidence=0.9)


def _worker(blur: dict | None):
    w = Worker.__new__(Worker)  # no models: a scripted face detector
    w.model, w.redactor = _Model(), Redactor(_Faces(), _Plates())
    w.engine, w.watch_spans, w.sent = WatchEngine(), {}, []
    w.configs = {"acc.src": {"zones": [], "privacy_masks": [], **({"blur": blur} if blur is not None else {})}}
    p = SourcePipeline("acc", "src", None, None)
    p.redact = lambda rgb: w.redact("acc.src", rgb)
    p.last_frame, p.last_frame_t = _scene(), time.time()
    w.pipelines = {"acc.src": p}

    async def publish(_js, items):
        w.sent.extend(items)

    w.publish = publish
    return w


def _snap(b64: str) -> np.ndarray:
    return decode_jpeg(base64.b64decode(b64))


def _diff(a, b, box) -> float:
    return float(np.abs(_region(a, box).astype(int) - _region(b, box).astype(int)).mean())


def test_ask_sends_the_model_a_blurred_frame_and_returns_it_when_the_source_asks():
    w = _worker({"faces": True, "plates": False})
    out = w.do_ask({"account_id": "acc", "source_id": "src", "question": "Who is there?"})
    sent = w.model.frames[0]
    assert _changed(_scene(), sent, FACE) and not _changed(_scene(), sent, PLATE)
    # The snapshot the caller gets is the frame the model saw (JPEG aside), not the raw one.
    snap = _snap(out["snapshot_jpeg_b64"])
    assert _diff(snap, sent, FACE) < _diff(snap, _scene(), FACE)


def test_ask_is_untouched_when_blurring_is_off():
    w = _worker(None)
    w.do_ask({"account_id": "acc", "source_id": "src", "question": "Who is there?", "describe": True})
    assert w.model.frames[0] is w.pipelines["acc.src"].last_frame


def test_an_agent_that_only_sees_blurred_media_gets_a_blurred_look_on_any_source():
    w = _worker({"faces": False, "plates": False})
    w.do_ask({"account_id": "acc", "source_id": "src", "question": "Who?", "blur": {"faces": True, "plates": True}})
    assert _changed(_scene(), w.model.frames[0], FACE) and _changed(_scene(), w.model.frames[0], PLATE)
    out = w.chat_look("acc", "src", "Who?", {}, Blur(faces=True))
    assert _changed(_scene(), w.model.frames[1], FACE)
    assert _diff(_snap(out["jpeg_b64"]), w.model.frames[1], FACE) < _diff(_snap(out["jpeg_b64"]), _scene(), FACE)


def test_snapshots_are_blurred():
    w = _worker({"faces": True})
    snap = decode_jpeg(w.pipelines["acc.src"].latest_jpeg())
    assert _diff(snap, _scene(), FACE) > 10
    assert _diff(snap, _scene(), (400, 0, 640, 50)) < 10  # JPEG noise only elsewhere


def test_stored_snapshots_are_blurred_before_a_model_sees_them():
    w = _worker({"faces": True})
    jpeg = base64.b64encode(encode_jpeg(_scene())).decode()
    w.do_check({"account_id": "acc", "source_id": "src", "prompt": "Is there a package?", "jpeg_b64": jpeg})
    w.chat_view_event({"source_id": "src", "jpeg_b64": jpeg}, "What is it?", {}, "acc")
    for frame in w.model.frames:
        assert _diff(frame, _scene(), FACE) > 10


def test_a_workflows_checks_are_metered_as_the_workflows_and_anything_else_as_before():
    w = _worker({"faces": True})
    jpeg = base64.b64encode(encode_jpeg(_scene())).decode()
    w.do_check({"account_id": "acc", "source_id": "src", "prompt": "A parcel?", "jpeg_b64": jpeg, "purpose": "workflow"})
    w.do_check({"account_id": "acc", "source_id": "src", "prompt": "A parcel?", "jpeg_b64": jpeg, "purpose": "anything"})
    w.do_ask({"account_id": "acc", "source_id": "src", "question": "A parcel?", "purpose": "workflow"})
    w.do_ask({"account_id": "acc", "source_id": "src", "question": "A parcel?"})
    assert [m["purpose"] for m in w.model.metas] == ["workflow", "backtest", "workflow", "ask"]
    # Blurred all the same.
    for frame in w.model.frames:
        assert _diff(frame, _scene(), FACE) > 10


def test_the_redact_request_blurs_a_stored_snapshot():
    w = _worker(None)
    jpeg = base64.b64encode(encode_jpeg(_scene())).decode()
    out = w.do_redact({"account_id": "acc", "source_id": "src", "jpeg_b64": jpeg})
    assert _diff(_snap(out["jpeg_b64"]), _scene(), FACE) > 10 and _diff(_snap(out["jpeg_b64"]), _scene(), PLATE) > 10


def test_a_watch_check_and_its_event_snapshot_are_blurred():
    w = _worker({"faces": True})
    f = Fire(watch_id="wat_1", account_id="acc", source_id="src", t=time.time(), description="someone", verify={"prompt": "Is someone there?"})
    f.frame, f.before = _scene(), _scene()
    asyncio.run(w.verify_and_publish(None, f))
    assert _changed(_scene(), w.model.frames[0], FACE)
    event = next(p for s, p in w.sent if s == "brain.event")
    assert _diff(_snap(event["snapshot_jpeg_b64"]), _scene(), FACE) > 10


def test_a_failing_detector_sends_nothing_unblurred():
    class Broken:
        def detect(self, _rgb):
            raise RuntimeError("model missing")

    w = _worker({"faces": True})
    w.redactor = Redactor(Broken(), _Plates())
    assert w.pipelines["acc.src"].latest_jpeg() is None
    with pytest.raises(RuntimeError):
        w.do_ask({"account_id": "acc", "source_id": "src", "question": "Who?"})
    assert w.model.frames == []


def _plates_seen(w) -> list:
    return w.redactor._plates.vehicles


def test_stored_snapshots_and_other_moments_get_the_whole_frame_plate_pass():
    w = _worker({"plates": True})
    jpeg = base64.b64encode(encode_jpeg(_scene())).decode()
    w.do_redact({"account_id": "acc", "source_id": "src", "jpeg_b64": jpeg})
    w.do_check({"account_id": "acc", "source_id": "src", "prompt": "Is there a car?", "jpeg_b64": jpeg})
    w.chat_view_event({"source_id": "src", "jpeg_b64": jpeg}, "What is it?", {}, "acc")
    assert _plates_seen(w) == [None, None, None]


def test_a_watch_frame_uses_its_tracks_and_the_before_frame_the_whole_frame():
    w = _worker({"plates": True})
    car = (80.0, 200.0, 200.0, 300.0)
    f = Fire(watch_id="wat_1", account_id="acc", source_id="src", t=time.time(), description="a car came and went", verify={"prompt": "Did a car leave?"})
    f.frame, f.before, f.boxes = _scene(), _scene(), ([], [car])
    asyncio.run(w.verify_and_publish(None, f))
    assert _plates_seen(w) == [[car], None]
    # A fire with no tracks (a sound, a schedule): the whole frame.
    g = Fire(watch_id="wat_1", account_id="acc", source_id="src", t=time.time(), description="a bark", verify={"prompt": "Is a dog there?"})
    g.frame = _scene()
    asyncio.run(w.verify_and_publish(None, g))
    assert _plates_seen(w)[-1] is None


def test_the_latest_frame_uses_its_tracks_and_none_tracked_means_the_whole_frame():
    w = _worker({"plates": True})
    w.pipelines["acc.src"].latest_jpeg()
    assert _plates_seen(w) == [[]]  # no vehicle tracked: an empty list, and PlateDetector scans the whole frame


def test_a_camera_with_no_config_is_blurred():
    w = _worker(None)
    w.configs = {}  # its config hasn't reached this brain (or was lost)
    w.do_ask({"account_id": "acc", "source_id": "src", "question": "Who?"})
    assert _changed(_scene(), w.model.frames[0], FACE) and _changed(_scene(), w.model.frames[0], PLATE)


def test_a_watch_whose_creator_only_sees_blurred_media_is_checked_blurred():
    w = _worker({"faces": False, "plates": False})
    w.engine.set_watch("acc.wat_1", {"id": "wat_1", "sources": ["src"], "status": "active", "blur": {"faces": True, "plates": True},
                                      "compiled": {"trigger": {"type": "motion"}, "verify": {"prompt": "Is someone there?"}}})
    f = Fire(watch_id="wat_1", account_id="acc", source_id="src", t=time.time(), description="someone", verify={"prompt": "Is someone there?"})
    f.frame = _scene()
    asyncio.run(w.verify_and_publish(None, f))
    assert _changed(_scene(), w.model.frames[0], FACE) and _changed(_scene(), w.model.frames[0], PLATE)
    # Without the watch's flag, the same camera is checked as it is.
    w.engine.set_watch("acc.wat_1", None)
    f2 = Fire(watch_id="wat_1", account_id="acc", source_id="src", t=time.time(), description="someone", verify={"prompt": "Is someone there?"})
    f2.frame = _scene()
    asyncio.run(w.verify_and_publish(None, f2))
    assert w.model.frames[1] is f2.frame


def test_the_latest_snapshot_is_made_off_the_event_loop():
    w = _worker({"faces": True})
    p = w.pipelines["acc.src"]
    seen = []
    real = p.latest_jpeg

    def latest():
        try:
            asyncio.get_running_loop()
            seen.append("loop")
        except RuntimeError:
            seen.append("thread")
        return real()

    class R:
        async def set(self, *_a, **_k):
            return True

    p.latest_jpeg = latest
    w.r, w.pending, w.backlog, w.last_snapshot, w.last_seen, w.last_tick, w.usage = R(), {"acc.src": []}, [], {}, {"acc.src": time.time()}, time.time(), []
    w.wake, w.watch_spans, w.monitors, w.sink = asyncio.Event(), {}, {}, None
    w.stats = {"frames_processed": 0, "frames_dropped": 0}

    async def ensure(_k):
        return None

    async def no_view_check(*_a):
        return None

    w.ensure_camera, w.view_check = ensure, no_view_check
    w.analyse = lambda key, jpeg, t: (p.last_frame, [], [])
    w.pending = {"acc.src": [(encode_jpeg(_scene()), time.time(), None, time.time())]}
    asyncio.run(_run_process(w))
    assert seen == ["thread"]


async def _run_process(w):
    await w.process(asyncio.get_running_loop())


def test_models_load_in_a_thread_when_a_camera_asks_for_blurring():
    loaded = []

    class Lazy(Redactor):
        def preload(self, blur):
            loaded.append((blur, threading.current_thread().name))

    w = Worker.__new__(Worker)
    w.configs, w.pipelines, w.redactor = {}, {}, Lazy()
    w.set_source("acc.src", {"zones": [], "blur": {"faces": True}})
    for t in threading.enumerate():
        if t.name == "blur-preload":
            t.join(5)
    assert loaded == [(Blur(faces=True), "blur-preload")]


def test_the_heartbeat_advertises_blurring():
    w = Worker.__new__(Worker)
    w.pipelines, w.last_seen, w._cpu, w.cpu_percent, w.brain_id, w.started_at = {}, {}, (time.process_time(), time.monotonic()), 0.0, "b1", "x"
    assert "blur" in w.load()["features"]


# --- the real models ----------------------------------------------------------------------------------
def _door_frame(n: int) -> np.ndarray:
    cap = cv2.VideoCapture(str(models.MODELS_DIR.parents[1] / "fixtures" / "doorstep-parcel-640x360.mp4"))
    cap.set(cv2.CAP_PROP_POS_FRAMES, n)
    ok, bgr = cap.read()
    assert ok
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)


def test_yunet_finds_the_face_at_the_door():
    # The fixture's publisher already pixelated the face; YuNet still finds where it is, which is what blurring needs.
    from senseplane_brain.redact import FaceDetector

    faces = FaceDetector().detect(_door_frame(195))
    assert any(270 <= (b[0] + b[2]) / 2 <= 320 and 100 <= (b[1] + b[3]) / 2 <= 150 for b, _ in faces)


def test_no_faces_on_an_empty_porch():
    from senseplane_brain.redact import FaceDetector

    assert FaceDetector().detect(_door_frame(30)) == []


def test_plate_model_runs_on_a_frame_and_a_vehicle_crop():
    from senseplane_brain.redact import PlateDetector

    # It may find something plate-like (it is tuned to blur too much rather than too little); boxes stay in the frame.
    for (x1, y1, x2, y2), score in PlateDetector().detect(_door_frame(30), [(100.0, 100.0, 300.0, 300.0)]):
        assert 0 <= x1 < x2 <= 640 and 0 <= y1 < y2 <= 360 and 0 < score <= 1
