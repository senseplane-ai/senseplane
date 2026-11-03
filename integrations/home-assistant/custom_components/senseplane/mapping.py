# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Home Assistant entity states → Senseplane readings (ADR 0060).

Numbers are sent in Senseplane's unit for their sense (°F → celsius, kW →
watt, ...); on/off entities become states (a door sensor's "on" is contact
true = open; a lock's "unlocked" is lock true); event entities (doorbells,
buttons) become events. Each reading names its entity as the device. No Home
Assistant imports: states come in as plain values, so this is testable on its own.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

Reading = dict[str, Any]

# binary_sensor device class → Senseplane state sense ("on" is true).
BINARY: dict[str, str] = {
    "door": "contact", "window": "contact", "garage_door": "contact", "opening": "contact",
    "motion": "motion", "occupancy": "occupancy", "presence": "occupancy", "moving": "motion",
    "moisture": "leak", "smoke": "smoke", "carbon_monoxide": "carbon_monoxide", "gas": "gas",
    "lock": "lock", "vibration": "vibration", "tamper": "tamper",
}
# Entity domains that are switched on and off.
SWITCHES = ("switch", "light", "fan", "input_boolean", "siren")
# Alarm panel states that count as armed (a triggered alarm is armed).
ARMED = ("armed_away", "armed_home", "armed_night", "armed_vacation", "armed_custom_bypass", "triggered")
# event entity device class → Senseplane event sense.
EVENTS: dict[str, str] = {"doorbell": "doorbell", "button": "button"}


def _scale(units: dict[str, Any]):
    def convert(value: float, unit: str) -> float | None:
        f = units.get(unit)
        if f is None:
            return None
        return f(value) if callable(f) else value * f
    return convert


# sensor device class → (sense, Senseplane unit, Home Assistant unit → factor or function).
NUMBERS: dict[str, tuple[str, str, Any]] = {
    "temperature": ("temperature", "celsius", _scale({"°C": 1, "C": 1, "": 1, "°F": lambda v: (v - 32) * 5 / 9, "F": lambda v: (v - 32) * 5 / 9, "K": lambda v: v - 273.15})),
    "humidity": ("humidity", "percent", _scale({"%": 1, "": 1})),
    "power": ("power", "watt", _scale({"W": 1, "kW": 1000, "mW": 0.001})),
    "energy": ("energy", "kilowatt_hour", _scale({"kWh": 1, "Wh": 0.001, "MWh": 1000})),
    "voltage": ("voltage", "volt", _scale({"V": 1, "mV": 0.001})),
    "current": ("current", "ampere", _scale({"A": 1, "mA": 0.001})),
    "illuminance": ("illuminance", "lux", _scale({"lx": 1})),
    "carbon_dioxide": ("co2", "ppm", _scale({"ppm": 1})),
    "pm25": ("pm25", "ugm3", _scale({"µg/m³": 1, "μg/m³": 1})),
    "pressure": ("pressure", "hectopascal", _scale({"hPa": 1, "mbar": 1, "kPa": 10, "Pa": 0.01, "bar": 1000, "inHg": 33.8639, "mmHg": 1.33322})),
    "atmospheric_pressure": ("pressure", "hectopascal", _scale({"hPa": 1, "mbar": 1, "kPa": 10, "Pa": 0.01, "inHg": 33.8639})),
    "battery": ("battery", "percent", _scale({"%": 1})),
    "sound_pressure": ("sound_level", "decibel", _scale({"dB": 1, "dBA": 1})),
}


def _number(state: str | None) -> float | None:
    try:
        value = float(state)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value


def to_reading(entity_id: str, state: str | None, attributes: dict[str, Any], at: datetime, *, initial: bool = False, temperature_unit: str = "°C") -> Reading | None:
    """A reading from an entity's state, or None when it isn't one Senseplane takes.

    ``initial`` is the state found at start-up: numbers and states are sent
    (the source has a value straight away), but an event entity's last event
    is not, since it happened before we were watching. ``temperature_unit``
    is Home Assistant's (a thermostat's setting is in it).
    """
    if state is None or state in ("unknown", "unavailable"):
        return None
    domain = entity_id.split(".", 1)[0]
    device_class = attributes.get("device_class")
    device = {"id": entity_id, **({"name": str(attributes["friendly_name"])} if attributes.get("friendly_name") else {})}
    base = {"device": device, "at": at.isoformat()}
    if domain == "binary_sensor":
        sense = BINARY.get(device_class or "")
        if not sense or state not in ("on", "off"):
            return None
        return {"sense": sense, "value": state == "on", **base}
    if domain in SWITCHES:
        if state not in ("on", "off"):
            return None
        return {"sense": "switch", "value": state == "on", **base}
    if domain == "lock":
        if state not in ("locked", "unlocked", "open"):
            return None
        return {"sense": "lock", "value": state != "locked", **base}
    if domain == "cover":
        if state not in ("open", "closed"):
            return None
        return {"sense": "cover", "value": state == "open", **base}
    if domain == "alarm_control_panel":
        if state in ARMED:
            return {"sense": "alarm", "value": True, **base}
        if state != "disarmed":
            return None
        return {"sense": "alarm", "value": False, **base}
    if domain == "climate":
        # The thermostat setting, in °C.
        raw = attributes.get("temperature")
        value = _number(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else None
        if value is None:
            return None
        if temperature_unit in ("°F", "F"):
            value = (value - 32) * 5 / 9
        return {"sense": "setpoint", "value": round(value, 2), "unit": "celsius", **base}
    if domain == "event":
        sense = EVENTS.get(device_class or "")
        if not sense or initial:
            return None
        kind = str(attributes.get("event_type") or "")
        detail = kind.removesuffix("_press").removesuffix("press").replace("_", " ").strip()
        return {"sense": sense, **({"detail": detail[:64]} if detail and detail not in ("ring", "pressed", "press") else {}), **base}
    if domain == "sensor":
        known = NUMBERS.get(device_class or "")
        value = _number(state)
        if not known or value is None:
            return None
        sense, unit, convert = known
        got = convert(value, str(attributes.get("unit_of_measurement") or "").strip())
        if got is None:
            return None
        return {"sense": sense, "value": round(got, 2), "unit": unit, **base}
    return None
