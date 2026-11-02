# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Entity states → readings (ADR 0060), without Home Assistant."""

from datetime import UTC, datetime

import pytest

from senseplane.mapping import to_reading

AT = datetime(2026, 10, 16, 12, 0, tzinfo=UTC)


def attrs(device_class=None, unit=None, name=None, **extra):
    return {k: v for k, v in {"device_class": device_class, "unit_of_measurement": unit, "friendly_name": name, **extra}.items() if v is not None}


@pytest.mark.parametrize(
    ("entity_id", "state", "attributes", "want"),
    [
        ("sensor.kitchen_temp", "21.46", attrs("temperature", "°C"), {"sense": "temperature", "value": 21.46, "unit": "celsius"}),
        ("sensor.kitchen_temp", "71.6", attrs("temperature", "°F"), {"sense": "temperature", "value": 22.0, "unit": "celsius"}),
        ("sensor.kitchen_temp", "300.15", attrs("temperature", "K"), {"sense": "temperature", "value": 27.0, "unit": "celsius"}),
        ("sensor.kitchen_hum", "48", attrs("humidity", "%"), {"sense": "humidity", "value": 48.0, "unit": "percent"}),
        ("sensor.kettle_power", "1.9", attrs("power", "kW"), {"sense": "power", "value": 1900.0, "unit": "watt"}),
        ("sensor.kettle_energy", "350", attrs("energy", "Wh"), {"sense": "energy", "value": 0.35, "unit": "kilowatt_hour"}),
        ("sensor.air", "1013", attrs("pressure", "hPa"), {"sense": "pressure", "value": 1013.0, "unit": "hectopascal"}),
        ("sensor.co2", "640", attrs("carbon_dioxide", "ppm"), {"sense": "co2", "value": 640.0, "unit": "ppm"}),
        ("binary_sensor.fridge", "on", attrs("door"), {"sense": "contact", "value": True}),
        ("binary_sensor.bathroom_window", "off", attrs("window"), {"sense": "contact", "value": False}),
        ("binary_sensor.hall_motion", "on", attrs("motion"), {"sense": "motion", "value": True}),
        ("binary_sensor.sink", "on", attrs("moisture"), {"sense": "leak", "value": True}),
        ("binary_sensor.smoke", "off", attrs("smoke"), {"sense": "smoke", "value": False}),
        ("switch.kettle", "on", attrs(), {"sense": "switch", "value": True}),
        ("light.hall", "off", attrs(), {"sense": "switch", "value": False}),
        ("lock.front", "unlocked", attrs(), {"sense": "lock", "value": True}),
        ("lock.front", "locked", attrs(), {"sense": "lock", "value": False}),
        ("event.doorbell", "2026-10-16T12:00:00+00:00", attrs("doorbell", event_type="ring"), {"sense": "doorbell"}),
        ("event.hall_button", "2026-10-16T12:00:00+00:00", attrs("button", event_type="double_press"), {"sense": "button", "detail": "double"}),
        # Not readings.
        ("sensor.kitchen_temp", "unavailable", attrs("temperature", "°C"), None),
        ("sensor.kitchen_temp", "unknown", attrs("temperature", "°C"), None),
        ("sensor.kitchen_temp", "nan", attrs("temperature", "°C"), None),
        ("sensor.kitchen_hum", "48", attrs("humidity", "g/m³"), None),
        ("sensor.data", "12", attrs("data_size", "GB"), None),
        ("sensor.thing", "1", attrs(), None),
        ("binary_sensor.update", "on", attrs("update"), None),
        ("lock.front", "jammed", attrs(), None),
        ("media_player.tv", "playing", attrs(), None),
    ],
)
def test_to_reading(entity_id, state, attributes, want):
    got = to_reading(entity_id, state, attributes, AT)
    if want is None:
        assert got is None
    else:
        assert got == {**want, "device": {"id": entity_id}, "at": "2026-10-16T12:00:00+00:00"}


def test_names_the_entity_as_the_device():
    got = to_reading("binary_sensor.fridge", "on", attrs("door", name="Fridge door"), AT)
    assert got["device"] == {"id": "binary_sensor.fridge", "name": "Fridge door"}


def test_skips_an_event_entitys_last_event_at_start_up():
    assert to_reading("event.doorbell", "2026-10-16T09:00:00+00:00", attrs("doorbell"), AT, initial=True) is None
    assert to_reading("binary_sensor.fridge", "on", attrs("door"), AT, initial=True) == {"sense": "contact", "value": True, "device": {"id": "binary_sensor.fridge"}, "at": AT.isoformat()}
