# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Entity states → readings (ADR 0060), without Home Assistant."""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from senseplane.mapping import to_reading

AT = datetime(2026, 10, 16, 12, 0, tzinfo=UTC)


def attrs(device_class=None, unit=None, name=None, **extra):
    return {k: v for k, v in {"device_class": device_class, "unit_of_measurement": unit, "friendly_name": name, **extra}.items() if v is not None}



CASES = json.loads((Path(__file__).resolve().parents[3] / "spec" / "home-assistant" / "readings.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[f"{c['entity_id']}={c['state']}" for c in CASES])
def test_to_reading(case):
    """The shared vectors (spec/home-assistant/readings.json), which the bridge tests too."""
    got = to_reading(case["entity_id"], case["state"], case["attributes"], AT, initial=case.get("initial", False))
    if case["want"] is None:
        assert got is None
    else:
        name = case["attributes"].get("friendly_name")
        assert got == {**case["want"], "device": {"id": case["entity_id"], **({"name": name} if name else {})}, "at": "2026-10-16T12:00:00+00:00"}


def test_names_the_entity_as_the_device():
    got = to_reading("binary_sensor.fridge", "on", attrs("door", name="Fridge door"), AT)
    assert got["device"] == {"id": "binary_sensor.fridge", "name": "Fridge door"}


def test_skips_an_event_entitys_last_event_at_start_up():
    assert to_reading("event.doorbell", "2026-10-16T09:00:00+00:00", attrs("doorbell"), AT, initial=True) is None
    assert to_reading("binary_sensor.fridge", "on", attrs("door"), AT, initial=True) == {"sense": "contact", "value": True, "device": {"id": "binary_sensor.fridge"}, "at": AT.isoformat()}


def test_a_fahrenheit_thermostat_setting_is_sent_in_celsius():
    got = to_reading("climate.hall", "heat", {"temperature": 71.6}, AT, temperature_unit="°F")
    assert got == {"sense": "setpoint", "value": 22.0, "unit": "celsius", "device": {"id": "climate.hall"}, "at": AT.isoformat()}
