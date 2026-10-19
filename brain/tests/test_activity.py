# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Activities (ADR 0057): presence, sound and watch spans with a start and an end."""

import asyncio
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pytest

from senseplane_brain.activity import HEARTBEAT_S, Spans
from senseplane_brain.detector import detectors
from senseplane_brain.offline import run_file
from senseplane_brain.pipeline import SourcePipeline
from senseplane_brain.sound import SoundClassifier
from senseplane_brain.tracker import Track
from senseplane_brain.watches import RECHECK_S, Ctx, WatchEngine
from senseplane_brain.worker import WATCH_GAP_S, Worker

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
LABELS = json.loads((FIXTURES / "labels.json").read_text())["fixtures"]
T0 = 1_000_000.0


def at(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def test_spans_open_heartbeat_and_close_after_their_gap():
    s = Spans("acc", "src")
    (opened,) = s.seen("presence", "person", "door", T0, 15, count=1, confidence=0.8)
    assert opened[0] == "brain.activity" and opened[1]["ended_at"] is None and opened[1]["zone"] == "door"
    assert s.seen("presence", "person", "door", T0 + 10, 15, count=2) == []  # still going, nothing to say
    (beat,) = s.seen("presence", "person", "door", T0 + HEARTBEAT_S + 1, 15)
    assert beat[1]["ended_at"] is None and beat[1]["peak_count"] == 2 and beat[1]["activity_key"] == opened[1]["activity_key"]
    assert s.tick(T0 + HEARTBEAT_S + 10) == []  # gone for 9 s: not yet
    (closed,) = s.tick(T0 + HEARTBEAT_S + 17)
    assert closed[1]["ended_at"] == closed[1]["last_seen_at"] and at(closed[1]["ended_at"]) == pytest.approx(T0 + HEARTBEAT_S + 1)
    # Back later: a new activity, with a new key.
    (again,) = s.seen("presence", "person", "door", T0 + 300, 15)
    assert again[1]["activity_key"] != opened[1]["activity_key"]
    (end,) = s.close_all()
    assert end[1]["ended_at"] == end[1]["started_at"]


@pytest.fixture(scope="module")
def runs():
    (det, confirm), snd = detectors(), SoundClassifier()
    out = {}
    for name in ("doorstep-parcel-640x360.mp4", "van-driving-640x360.mp4", "baby-crying-audio-640x360.mp4", "night-sky-empty-640x480.mp4"):
        p = SourcePipeline("acc", "src", det, snd, confirm=confirm)
        p.zones = [{"name": "doorstep", "polygon": [[0, 0.5], [1, 0.5], [1, 1], [0, 1]]}]
        events = run_file(str(FIXTURES / name), p, t0=T0)
        out[name] = [pl for _, s, pl in events if s == "brain.activity"]
    return out


def closed(acts, **match):
    return [a for a in acts if a["ended_at"] and all(a.get(k) == v for k, v in match.items())]


def test_a_person_at_the_door_is_one_presence_span_close_to_when_they_were_there(runs):
    expect = next(e for e in LABELS["doorstep-parcel-640x360.mp4"]["expect"] if e["label"] == "person")
    (person,) = closed(runs["doorstep-parcel-640x360.mp4"], kind="presence", label="person", zone=None)
    start, end = at(person["started_at"]) - T0, at(person["ended_at"]) - T0
    assert abs(start - expect["from"]) <= 2.0, start
    assert abs(end - expect["to"]) <= 3.0, end
    assert person["peak_count"] >= 1 and person["confidence"] >= 0.5
    # Every activity that opened also closed, once.
    keys = {a["activity_key"] for a in runs["doorstep-parcel-640x360.mp4"]}
    assert len(closed(runs["doorstep-parcel-640x360.mp4"])) == len(keys)


def test_zones_get_their_own_span(runs):
    zoned = closed(runs["doorstep-parcel-640x360.mp4"], kind="presence", label="person", zone="doorstep")
    assert zoned, "the person stands in the lower half of the frame"


def test_a_vehicle_and_a_sound_each_give_a_span_and_an_empty_view_gives_none(runs):
    assert closed(runs["van-driving-640x360.mp4"], kind="presence", label="vehicle", zone=None)
    crying = closed(runs["baby-crying-audio-640x360.mp4"], kind="sound", label="crying")
    assert crying and at(crying[0]["ended_at"]) - at(crying[0]["started_at"]) >= 5
    assert runs["night-sky-empty-640x480.mp4"] == []


def _track(i, label="person", box=(100, 100, 200, 300)):
    return Track(id=i, label=label, box=box, score=0.9, first_seen=0, last_seen=0, confirmed=True)


def test_a_tracking_watch_asks_again_while_its_condition_holds_and_has_no_cooldown():
    eng = WatchEngine()
    eng.set_watch("acc.wat_1", {"id": "wat_1", "sources": ["src"], "mode": "track", "status": "active",
                                "compiled": {"trigger": {"type": "objects", "label": "person", "on": "present", "min_duration_s": 0},
                                             "verify": {"prompt": "Is the person eating?"}, "cooldown_s": 600}})
    tracks = [_track(1)]
    frame = lambda t: Ctx(t, tracks, {1: []}, None, {})  # noqa: E731
    (fire,) = eng.evaluate("acc", "src", frame(T0))
    assert fire.mode == "track"
    eng.check_failed("acc", "wat_1", "src", T0)
    assert eng.evaluate("acc", "src", frame(T0 + RECHECK_S - 1)) == []
    (again,) = eng.evaluate("acc", "src", frame(T0 + RECHECK_S + 1))  # asked again: still sitting there
    assert again.watch_id == "wat_1"
    assert eng.holding_now("acc", "wat_1", "src") is True
    assert eng.evaluate("acc", "src", Ctx(T0 + RECHECK_S + 2, [], {}, None, {})) == []  # gone
    assert eng.holding_now("acc", "wat_1", "src") is False
    (back,) = eng.evaluate("acc", "src", frame(T0 + RECHECK_S + 5))  # back 3 s later: no 600 s cooldown
    assert back.mode == "track"


class _Yes:
    def ask(self, *_a):
        from senseplane_brain.vlm import Answer

        return Answer(answer="The person is eating at the table.", yes=True, confidence=0.9)


def test_a_tracking_watch_records_a_span_while_it_holds_and_posts_no_event():
    w = Worker.__new__(Worker)
    w.model, w.engine, w.watch_spans, w.sent = _Yes(), WatchEngine(), {}, []

    async def publish(_sink, items):
        w.sent.extend(items)

    w.publish = publish
    w.engine.set_watch("acc.wat_1", {"id": "wat_1", "sources": ["src"], "mode": "track", "status": "active",
                                     "compiled": {"trigger": {"type": "objects", "label": "person", "on": "present", "min_duration_s": 0},
                                                  "verify": {"prompt": "Is the person eating?"}}})
    tracks = [_track(1)]
    (fire,) = w.engine.evaluate("acc", "src", Ctx(T0, tracks, {1: []}, None, {}))
    fire.frame = np.zeros((8, 8, 3), dtype=np.uint8)
    asyncio.run(w.verify_and_publish(None, fire))
    assert [s for s, _ in w.sent] == ["brain.activity"]  # no watch.triggered for a tracking watch
    assert w.sent[0][1]["summary"] == "The person is eating at the table." and w.sent[0][1]["ended_at"] is None
    # Still eating 5 min later: the span keeps going (heartbeats); then they leave.
    for t in range(1, 301, 5):
        w.engine.evaluate("acc", "src", Ctx(T0 + t, tracks, {1: []}, None, {}))
        w.sent += w.watch_activity("acc.src", T0 + t)
    w.engine.evaluate("acc", "src", Ctx(T0 + 300, [], {}, None, {}))  # last seen eating at +296
    assert w.watch_activity("acc.src", T0 + 296 + WATCH_GAP_S - 1) == []
    (end,) = w.watch_activity("acc.src", T0 + 296 + WATCH_GAP_S + 1)
    assert at(end[1]["ended_at"]) - at(end[1]["started_at"]) == pytest.approx(296, abs=1)
