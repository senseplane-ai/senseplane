# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""The adaptive detector rate (docs/milestones/brain-tuning.md): unchanged pictures are
looked at every few seconds, never not at all, so a mug on a desk is still seen; and the
cascade, where a cheap detector finds and the confirm detector decides events."""

import numpy as np

from senseplane_brain.detector import Detection
from senseplane_brain.pipeline import Config, SourcePipeline
from senseplane_brain.watches import WatchEngine

STILL = np.full((360, 640, 3), 90, np.uint8)
MUG = Detection("cup", 0.8, (300.0, 200.0, 340.0, 240.0))


class Counting:
    def __init__(self, dets):
        self.dets, self.calls = dets, 0

    def detect(self, _rgb):
        self.calls += 1
        return list(self.dets)


def run(pipeline, frames, t0=1000.0, engine=None):
    fires = []
    for i, f in enumerate(frames):
        t = t0 + i / 5
        pipeline.on_frame(f, t)
        if engine:
            fires += engine.on_frame("acc", "src", pipeline.tracker.active, pipeline.motion.last_mask, [], f, t)
    return fires


def test_an_unchanged_picture_is_detected_every_few_seconds():
    det = Counting([])
    run(SourcePipeline("acc", "src", det, None), [STILL] * 150)  # 30 s at 5 fps
    assert 3 <= det.calls <= 4  # nothing tracked: every 10 s (adaptive=False: every 5th frame, 30 calls)
    mug = Counting([MUG])
    run(SourcePipeline("acc", "src", mug, None), [STILL] * 150)
    assert mug.calls >= 30  # something tracked: still looked at often enough to keep its track
    old = Counting([])
    run(SourcePipeline("acc", "src", old, None, config=Config(adaptive=False)), [STILL] * 150)
    assert old.calls == 30


def test_a_stationary_object_still_fires_a_present_watch():
    det = Counting([MUG])
    p = SourcePipeline("acc", "src", det, None)
    engine = WatchEngine()
    engine.set_watch("acc.wat_mug", {"id": "wat_mug", "sources": ["src"], "mode": "alert", "status": "active",
                                     "compiled": {"trigger": {"type": "objects", "label": "cup", "on": "present", "min_duration_s": 5}, "cooldown_s": 60}})
    fires = run(p, [STILL] * 100, engine=engine)
    assert len(fires) == 1 and fires[0].t - 1000.0 <= 10


def test_new_movement_is_detected_on_every_frame():
    def square(i):
        f = STILL.copy()
        f[100:180, 40 * i:40 * i + 80] = 250  # something walks across
        return f

    frames = [STILL] * 10 + [square(i) for i in range(10)]
    det = Counting([])
    run(SourcePipeline("acc", "src", det, None), frames)
    assert det.calls >= 10  # the 10 changing frames, each one


def moving(i):
    f = STILL.copy()
    f[100:180, (40 * i) % 560:(40 * i) % 560 + 80] = 250
    return f


def test_motion_that_shows_nothing_is_looked_at_less_after_a_while():
    det = Counting([])
    run(SourcePipeline("acc", "src", det, None), [moving(i) for i in range(50)])  # 10 s of "rain"
    # Every frame for the first 3 s (16), then every 0.4 s (18): not all 50.
    assert 25 <= det.calls <= 40


PERSON = Detection("person", 0.9, (300.0, 100.0, 360.0, 300.0))


def events(p, frames):
    out = []
    for i, f in enumerate(frames):
        out += [x for s, x in p.on_frame(f, 1000.0 + i / 5) if s == "brain.event"]
    return out


def test_cascade_posts_only_what_the_confirm_detector_sees():
    finder, confirm = Counting([PERSON]), Counting([PERSON])
    p = SourcePipeline("acc", "src", finder, None, confirm=confirm)
    got = events(p, [moving(i) for i in range(25)])
    assert [e["type"] for e in got] == ["detection.person"]
    # Confirmed once it is settled: the cheap detector follows it from there.
    assert confirm.calls == 1 and finder.calls >= 20


def test_cascade_ignores_what_the_confirm_detector_keeps_missing():
    finder, confirm = Counting([PERSON]), Counting([])
    p = SourcePipeline("acc", "src", finder, None, confirm=confirm)
    got = events(p, [moving(i) for i in range(100)])  # 20 s
    assert got == []
    # Checked every 0.4 s until it has missed three times in the same place, then left alone for 30 s.
    assert confirm.calls == 3
