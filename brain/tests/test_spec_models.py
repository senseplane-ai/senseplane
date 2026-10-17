# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""The generated models must accept the documented examples."""

import pytest
from pydantic import TypeAdapter, ValidationError

from senseplane_brain.spec import event, trigger


def test_event_example_parses() -> None:
    ev = event.Event.model_validate(
        {
            "id": "evt_01J9ZZZZZZZZZZZZZZZZZZZZZZ",
            "type": "watch.triggered",
            "watch_id": "wat_01J9ZZZZZZZZZZZZZZZZZZZZZZ",
            "source": {"id": "src_frontdoor", "sense": "video", "location": "Front door"},
            "occurred_at": "2026-10-14T21:02:11+02:00",
            "summary": "A courier left a brown box on the doormat.",
            "labels": ["person", "package"],
            "confidence": 0.91,
            "value": None,
            "media": {"snapshot_url": "https://example.com/s.jpg"},
        }
    )
    assert ev.type == "watch.triggered"


def test_package_watch_sequence_trigger_parses() -> None:
    adapter = TypeAdapter(trigger.Trigger)
    t = adapter.validate_python(
        {
            "type": "sequence",
            "within_s": 600,
            "steps": [
                {"type": "objects", "label": "person", "on": "enter", "zone": "front_door"},
                {"type": "objects", "label": "person", "on": "leave"},
            ],
        }
    )
    assert t.root.type == "sequence" if hasattr(t, "root") else t.type == "sequence"


def test_schedule_trigger_rejects_too_frequent() -> None:
    with pytest.raises(ValidationError):
        TypeAdapter(trigger.Trigger).validate_python({"type": "schedule", "every_min": 1})
