# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import typing

from senseplane import (
    KNOWN_SENSES,
    LABELS,
    SENSES,
    UNIT_SYMBOLS,
    Label,
    detection_label,
    is_label,
    is_sensor_sense,
    label_name,
    reading_text,
    sense_info,
    sense_name,
    state_word,
    unit_symbol,
)
from senseplane.types import Objects

from .conftest import REPO


def test_labels_are_spec_labels_in_order() -> None:
    spec = json.loads((REPO / "spec" / "labels.json").read_text())["labels"]
    assert [(info.label, info.name) for info in LABELS] == [(x["label"], x["name"]) for x in spec]
    assert [info.label for info in LABELS if info.group] == ["person", "vehicle", "animal"]
    assert [info.label for info in LABELS if not info.events] == [x["label"] for x in spec if x.get("events") is False]
    assert list(typing.get_args(Label)) == [x["label"] for x in spec]


def test_label_helpers() -> None:
    assert label_name("cup") == "Cup"
    assert label_name("teddy_bear") == "Teddy bear"
    assert label_name("tv") == "TV"
    assert label_name("glass_break") == "Glass break"  # not a label: words
    assert detection_label("detection.laptop") == "laptop"
    assert detection_label("watch.triggered") is None
    assert is_label("phone") and not is_label("mug")


def test_objects_trigger_takes_a_label() -> None:
    t = Objects.model_validate({"type": "objects", "label": "backpack", "on": "stationary", "min_duration_s": 600})
    assert t.label == "backpack"


def test_known_senses_are_the_schema_enum() -> None:
    spec = json.loads((REPO / "spec" / "schemas" / "sense.json").read_text())
    assert list(KNOWN_SENSES) == spec["anyOf"][0]["enum"]


def test_sensor_senses_are_spec_senses() -> None:
    spec = json.loads((REPO / "spec" / "senses.json").read_text())
    assert [s.sense for s in SENSES] == [x["sense"] for x in spec["senses"]]
    assert UNIT_SYMBOLS == spec["units"]


def test_sense_helpers_match_the_typescript_sdk() -> None:
    # The cases of sdk/typescript/src/senses.test.ts.
    power, contact, doorbell = sense_info("power"), sense_info("contact"), sense_info("doorbell")
    assert power and (power.kind, power.unit) == ("number", "watt")
    assert contact and (contact.kind, contact.on, contact.off) == ("state", "open", "closed")
    assert doorbell and doorbell.kind == "event"
    assert sense_info("soil_moisture") is None
    assert sense_name("contact") == "door or window"
    assert sense_name("soil_moisture") == "soil moisture"
    assert state_word("lock", True) == "unlocked"
    assert state_word("mailbox", False) == "off"
    assert unit_symbol("ugm3") == "µg/m³"
    assert not is_sensor_sense("audio") and is_sensor_sense("leak")
    assert reading_text({"sense": "temperature", "kind": "number", "value": 21.46, "unit": "celsius"}) == "21.5 °C"
    assert reading_text({"sense": "humidity", "value": 40, "unit": "percent"}) == "40%"
    assert reading_text({"sense": "contact", "kind": "state", "value": True}) == "open"
    assert reading_text({"sense": "contact", "kind": "state", "value": False, "state": "closed"}) == "closed"
    assert reading_text({"sense": "button", "kind": "event", "detail": "double"}) == "pressed (double)"
    assert reading_text({"sense": "doorbell", "kind": "event"}) == "rang"
    assert reading_text({"sense": "power", "value": 12.25, "unit": "watt"}) == "12.3 W"  # halves up, as Math.round
