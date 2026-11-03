# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
import typing

from senseplane import LABELS, SENSES, Label, detection_label, is_label, label_name
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


def test_senses() -> None:
    assert SENSES == ("video", "audio", "temperature", "humidity")
