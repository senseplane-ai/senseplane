# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Watch engine on fixtures: the package watch's cheap trigger (a person
arrives, then has left for a few seconds) fires once after the delivery; on the van clip people
in the background also come and go, which is exactly what the VLM check is for;
empty scenes never fire."""

from pathlib import Path

import pytest

from senseplane_brain.compiler import rules
from senseplane_brain.detector import YoloxDetector
from senseplane_brain.offline import run_file
from senseplane_brain.pipeline import SourcePipeline
from senseplane_brain.watches import Ctx, SequenceState, WatchEngine, active_now

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


def watch(instruction, zones=(), senses=("video",)):
    c = rules(instruction, list(zones), list(senses))
    return {"id": "wat_test", "sources": ["src"], "mode": "alert", "status": "active", "compiled": c.compiled}


@pytest.fixture(scope="module")
def detector():
    return YoloxDetector()


def fires_on(fixture, w, detector):
    engine = WatchEngine()
    engine.set_watch("acc.wat_test", w)
    fires = []

    def hook(p, frame, t):
        fires.extend(engine.on_frame("acc", "src", p.tracker.active, p.motion.last_mask, [], frame, t))

    run_file(str(FIXTURES / fixture), SourcePipeline("acc", "src", detector, None), after_frame=hook)
    return fires


def test_package_watch_fires_once_after_the_delivery(detector):
    w = watch("Tell me if a package is left at the front door")
    door = fires_on("doorstep-delivery-reversed-640x360.mp4", w, detector)
    assert len(door) == 1, door
    assert door[0].t - 1_000_000.0 > 30  # after the person has been gone for a few seconds, not while crouching
    assert door[0].verify["prompt"].startswith("Is there a package")
    assert door[0].frame is not None
    # The frame from when the person arrived goes along, so the check can compare before and after.
    assert door[0].before is not None and door[0].before.shape == door[0].frame.shape and (door[0].before != door[0].frame).any()
    assert len(fires_on("van-driving-640x360.mp4", w, detector)) <= 1  # background people; the VLM rejects it
    for empty in ("rain-window-night-640x360.mp4", "night-sky-empty-640x480.mp4", "storm-rain-night-360x640.mp4"):
        assert fires_on(empty, w, detector) == [], empty


def test_sequence_resets_after_window():
    s = SequenceState({"type": "sequence", "within_s": 10, "steps": [{"type": "schedule", "every_min": 5}, {"type": "schedule", "every_min": 5}]})
    assert s.step(Ctx(0, tick=True)) is False  # step 1
    assert s.step(Ctx(400, tick=True)) is False  # too late: window expired, this tick restarts step 1


def test_active_hours():
    # 2026-10-16 is a Friday; 12:00 UTC.
    t = 1792152000.0
    assert active_now(None, t)
    assert active_now([{"days": ["fri"], "from": "08:00", "to": "20:00"}], t)
    assert not active_now([{"days": ["sat"], "from": "08:00", "to": "20:00"}], t)
    assert active_now([{"days": ["fri"], "from": "22:00", "to": "06:00"}], t) is False


def test_questions_about_activities_compile_to_condition_and_digest_watches():
    """ADR 0057: absence by a time, no one for a while and a daily summary are checked by the API on a schedule."""
    from senseplane_brain.compiler import rules

    track = [{"id": "wat_eat", "instruction": "Track meals at the table", "mode": "track"}, {"id": "wat_door", "instruction": "Door", "mode": "alert"}]
    c = rules("Tell me if nobody has been in the kitchen by 10am", ["kitchen"], ["video"], track).compiled
    assert c["trigger"] == {"type": "condition", "query": {"measure": "count", "what": {"label": "person", "zone": "kitchen"}}, "test": {"op": "eq", "value": 0}, "at": "10:00"}
    assert c["cooldown_s"] == 0 and "verify" not in c
    c = rules("Alert me if there is no movement in the hallway for 2 hours", ["hallway"], ["video"]).compiled
    assert c["trigger"]["query"] == {"measure": "since_last", "what": {"label": "person", "zone": "hallway"}} and c["trigger"]["test"] == {"op": "gte", "value": 7200}
    assert c["trigger"]["every_min"] == 10
    assert rules("Tell me if mum isn't up by 9:30 pm", [], ["video"]).compiled["trigger"]["at"] == "21:30"
    d = rules("Send me a summary of Mum's day every evening", [], ["video"], track).compiled["trigger"]
    assert d["type"] == "digest" and d["at"] == "20:00"
    assert [i["label"] for i in d["items"]][:2] == ["First seen", "Last seen"]
    assert {"label": "Track meals at the table", "query": {"measure": "count", "what": {"watch_id": "wat_eat"}, "compare": "last_14_days"}} in d["items"]
    assert not any(i["query"]["what"].get("watch_id") == "wat_door" for i in d["items"])  # alert watches aren't summarised
    # Ordinary watches are unchanged.
    assert rules("Tell me if someone comes to the door", [], ["video"]).compiled["trigger"]["type"] == "objects"
    assert rules("Tell me if the dog is on the sofa for 5 minutes", [], ["video"]).compiled["trigger"]["type"] == "objects"
    # What the spec accepts.
    from pydantic import TypeAdapter

    from senseplane_brain.spec.trigger import Trigger

    TypeAdapter(Trigger).validate_python(d)
    TypeAdapter(Trigger).validate_python(rules("Alert me if no one has been seen for 3 hours", [], ["video"]).compiled["trigger"])
