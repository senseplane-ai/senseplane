# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Everyday objects (spec/labels.json): the COCO mapping, object events that do not
spam, tracks that survive a missed frame, and watches compiled for them."""

import json
from pathlib import Path

import numpy as np
import pytest

from senseplane_brain import labels
from senseplane_brain.compiler import SYSTEM, rules
from senseplane_brain.detector import LABELS, Detection
from senseplane_brain.pipeline import SourcePipeline
from senseplane_brain.tracker import Tracker
from senseplane_brain.watches import WatchEngine

SPEC = Path(__file__).resolve().parents[2] / "spec" / "labels.json"
FRAME = np.zeros((360, 640, 3), np.uint8)


def test_the_brain_copy_is_the_spec():
    assert json.loads(SPEC.read_text()) == json.loads((Path(labels.__file__).parent / "spec" / "labels.json").read_text())


def test_coco_mapping_keeps_the_groups_and_adds_every_other_class():
    assert sorted(LABELS) == list(range(80))
    assert LABELS[0] == "person"
    assert {LABELS[i] for i in (1, 2, 3, 5, 7)} == {"vehicle"}
    assert {LABELS[i] for i in range(14, 24)} == {"animal"}
    assert (LABELS[41], LABELS[63], LABELS[67], LABELS[24], LABELS[56], LABELS[73]) == ("cup", "laptop", "phone", "backpack", "chair", "book")
    assert (LABELS[57], LABELS[58], LABELS[60], LABELS[62], LABELS[64]) == ("couch", "plant", "table", "tv", "computer_mouse")
    assert len(labels.LABELS) == 67 and len(labels.OBJECTS) == 64
    assert labels.MIN_SCORE["person"] == 0.5 and labels.MIN_SCORE["animal"] == 0.6 and labels.MIN_SCORE["phone"] == 0.6
    assert labels.phrase("person") == "A person" and labels.phrase("animal") == "An animal" and labels.phrase("umbrella") == "An umbrella"
    assert labels.phrase("tv") == "A TV" and labels.phrase("teddy_bear") == "A teddy bear"


class Scripted:
    """A detector that reports what the scene says at time t."""

    def __init__(self, scene):
        self.scene, self.t = scene, 0.0

    def detect(self, _rgb):
        return [Detection(lbl, 0.8, box) for lbl, box in self.scene(self.t)]


def run(scene, until: float, start: float = 1000.0):
    det = Scripted(scene)
    p = SourcePipeline("acc", "src", det, None)
    events = []
    for i in range(int(until * 5)):
        t = i / 5
        det.t = t
        events += [(t, payload) for s, payload in p.on_frame(FRAME, start + t) if s == "brain.event"]
    return events


CUP = (300.0, 200.0, 330.0, 240.0)
COUCH = (20.0, 150.0, 300.0, 340.0)


def test_object_events_skip_the_scenery_and_repeat_at_most_every_five_minutes():
    def scene(t):
        out = [("cup", CUP)] if 30 <= t < 60 or 100 <= t < 130 or t >= 400 else []
        out.append(("couch", COUCH))  # furniture: in view all along, never an event
        return out

    events = run(scene, 420)
    types = [(int(t // 10 * 10), e["type"]) for t, e in events]  # 10 s buckets: an unchanged picture is not detected on every frame
    assert types == [(30, "detection.cup"), (400, "detection.cup")], types  # 100 s is inside the cooldown
    assert events[0][1]["summary"] == "A cup was seen."
    assert events[0][1]["labels"] == ["cup"]


def test_objects_in_view_at_start_are_scenery_but_people_are_not():
    events = run(lambda t: [("laptop", CUP), ("person", (100.0, 50.0, 200.0, 350.0))], 20)
    assert [e["type"] for _, e in events] == ["detection.person"]
    assert events[0][1]["summary"] == "A person was seen."


def test_a_stationary_track_that_drops_out_comes_back_as_itself():
    tr = Tracker(640, 360)
    t = 0.0
    while t < 12:
        tr.update([Detection("cup", 0.8, CUP)], t)
        t += 0.2
    (cup,) = tr.active
    assert cup.stationary
    for _ in range(15):  # missed for 3 s: dropped
        tr.update([], t)
        t += 0.2
    assert tr.active == []
    tr.update([Detection("cup", 0.8, CUP)], t)
    assert [x.id for x in tr.active] == [cup.id] and tr.active[0].stationary


def test_a_compiled_object_watch_fires_on_a_left_mug():
    c = rules("Tell me when a mug is left on the desk", ["desk"], ["video"])
    engine = WatchEngine()
    engine.set_watch("acc.wat_1", {"id": "wat_1", "sources": ["src"], "status": "active", "compiled": c.compiled})
    zones = [{"name": "desk", "polygon": [[0.4, 0.4], [0.6, 0.4], [0.6, 0.8], [0.4, 0.8]]}]
    tr = Tracker(640, 360)
    fires, t = [], 0.0
    while t < 100:
        tr.update([Detection("cup", 0.8, CUP)], t)
        fires += engine.on_frame("acc", "src", tr.active, None, zones, FRAME, t)
        t += 0.2
    assert len(fires) == 1
    assert 70 <= fires[0].t <= 72  # 10 s to count as still, then 60 s
    assert fires[0].verify["prompt"].startswith("Is there a mug left on the desk?")


@pytest.mark.parametrize("sentence,zones,trigger,prompt", [
    ("Tell me when a mug is left on the desk", ["desk"],
     {"type": "objects", "label": "cup", "on": "stationary", "zone": "desk", "min_duration_s": 60.0}, "Is there a mug left on the desk?"),
    ("Alert me if someone takes the laptop", [],
     {"type": "objects", "label": "laptop", "on": "leave", "min_duration_s": 30.0}, "Is the laptop gone (no laptop in view)?"),
    ("Let me know if a backpack is left by the door for 10 minutes", ["door"],
     {"type": "objects", "label": "backpack", "on": "stationary", "zone": "door", "min_duration_s": 600.0}, "Is there a backpack left by the door?"),
    ("Tell me if my phone is left in the kitchen", [],
     {"type": "objects", "label": "phone", "on": "stationary", "min_duration_s": 60.0}, "Is there a phone left in the kitchen?"),
    ("Tell me if someone leaves a bag by the door", [],
     {"type": "objects", "label": "backpack", "on": "stationary", "min_duration_s": 60.0}, "Is there a bag left by the door?"),
    ("Notify me when a suitcase appears in the hall", ["hall"],
     {"type": "objects", "label": "suitcase", "on": "present", "zone": "hall", "min_duration_s": 5.0}, "Is there a suitcase in the hall?"),
    ("Tell me if more than 3 cups are on the table", [],
     {"type": "objects", "label": "cup", "on": "present", "min_count": 4, "min_duration_s": 5.0}, "Are there at least 4 cups on the table?"),
    ("Tell me if a wine glass is left on the table", [],
     {"type": "objects", "label": "wine_glass", "on": "stationary", "min_duration_s": 60.0}, "Is there a wine glass left on the table?"),
])
def test_object_sentences_compile_to_object_triggers(sentence, zones, trigger, prompt):
    c = rules(sentence, zones, ["video"])
    assert c.compiled["trigger"] == trigger
    assert c.compiled["verify"]["prompt"].startswith(prompt)


@pytest.mark.parametrize("sentence,label", [
    ("Tell me when a person arrives", "person"),
    ("Tell me if a dog gets on the sofa", "animal"),
    ("Tell me if someone sits on the couch", "person"),
    ("Tell me if a car parks in front of the house", "vehicle"),
    ("Tell me if a person in an orange jacket comes to the door", "person"),
])
def test_people_vehicles_and_animals_still_win_when_they_are_the_subject(sentence, label):
    assert rules(sentence, [], ["video"]).compiled["trigger"]["label"] == label


def test_person_arrival_is_an_enter_trigger_without_a_check():
    c = rules("Tell me when a person arrives", [], ["video"])
    assert c.compiled["trigger"] == {"type": "objects", "label": "person", "on": "enter"}
    assert "verify" not in c.compiled


@pytest.mark.parametrize("sentence,kind", [
    ("Tell me if the fridge is open", "schedule"),
    ("Tell me when the TV is on", "schedule"),
    ("Alert me if glass breaks", "sound"),
    ("Tell me if a package is left at the front door", "sequence"),
])
def test_states_sounds_and_packages_keep_their_triggers(sentence, kind):
    assert rules(sentence, [], ["video", "audio"]).compiled["trigger"]["type"] == kind


def test_durations_in_plural_units():
    c = rules("Tell me if a car is parked outside for 2 minutes", [], ["video"])
    assert c.compiled["trigger"]["min_duration_s"] == 120.0


def test_the_model_prompt_lists_every_label_and_common_synonyms():
    for lbl in labels.LABELS:
        assert lbl in SYSTEM
    for pair in ("mug→cup", "sofa→couch", "mobile→phone", "television→tv", "computer→laptop", "bag→backpack", "fridge→refrigerator"):
        assert pair in SYSTEM, pair
