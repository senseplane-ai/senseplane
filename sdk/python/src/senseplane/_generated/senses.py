# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
# Generated from spec/senses.json. Do not edit; run `uv run python scripts/codegen.py` in sdk/python.

from typing import Literal, NamedTuple

ReadingKind = Literal["number", "state", "event"]


class SenseInfo(NamedTuple):
    """A known sensor sense: a number in `unit`, an on/off state (`on` is what true means) or an event."""

    sense: str
    kind: ReadingKind
    name: str
    unit: str | None = None
    on: str | None = None
    off: str | None = None


UNIT_SYMBOLS: dict[str, str] = {
    "celsius": "°C",
    "percent": "%",
    "watt": "W",
    "kilowatt_hour": "kWh",
    "volt": "V",
    "ampere": "A",
    "lux": "lx",
    "ppm": "ppm",
    "ugm3": "µg/m³",
    "hectopascal": "hPa",
    "decibel": "dB",
}
"""How each unit is shown."""

SENSES: tuple[SenseInfo, ...] = (
    SenseInfo(sense="temperature", kind="number", name="temperature", unit="celsius"),
    SenseInfo(sense="humidity", kind="number", name="humidity", unit="percent"),
    SenseInfo(sense="power", kind="number", name="power use", unit="watt"),
    SenseInfo(sense="energy", kind="number", name="energy used", unit="kilowatt_hour"),
    SenseInfo(sense="voltage", kind="number", name="voltage", unit="volt"),
    SenseInfo(sense="current", kind="number", name="current", unit="ampere"),
    SenseInfo(sense="illuminance", kind="number", name="light level", unit="lux"),
    SenseInfo(sense="co2", kind="number", name="CO2", unit="ppm"),
    SenseInfo(sense="pm25", kind="number", name="PM2.5", unit="ugm3"),
    SenseInfo(sense="pressure", kind="number", name="air pressure", unit="hectopascal"),
    SenseInfo(sense="battery", kind="number", name="battery", unit="percent"),
    SenseInfo(sense="sound_level", kind="number", name="sound level", unit="decibel"),
    SenseInfo(sense="contact", kind="state", name="door or window", on="open", off="closed"),
    SenseInfo(sense="motion", kind="state", name="motion", on="motion", off="clear"),
    SenseInfo(sense="occupancy", kind="state", name="presence", on="occupied", off="clear"),
    SenseInfo(sense="leak", kind="state", name="leak", on="wet", off="dry"),
    SenseInfo(sense="smoke", kind="state", name="smoke", on="smoke", off="clear"),
    SenseInfo(sense="carbon_monoxide", kind="state", name="carbon monoxide", on="detected", off="clear"),
    SenseInfo(sense="gas", kind="state", name="gas", on="detected", off="clear"),
    SenseInfo(sense="switch", kind="state", name="switch", on="on", off="off"),
    SenseInfo(sense="lock", kind="state", name="lock", on="unlocked", off="locked"),
    SenseInfo(sense="vibration", kind="state", name="vibration", on="vibration", off="still"),
    SenseInfo(sense="tamper", kind="state", name="tampering", on="tampered", off="clear"),
    SenseInfo(sense="button", kind="event", name="button press"),
    SenseInfo(sense="doorbell", kind="event", name="doorbell"),
    SenseInfo(sense="cover", kind="state", name="blind or cover", on="open", off="closed"),
    SenseInfo(sense="alarm", kind="state", name="alarm system", on="armed", off="disarmed"),
    SenseInfo(sense="setpoint", kind="number", name="thermostat setting", unit="celsius"),
)
"""The known sensor senses (ADR 0060); readings of other senses are accepted too."""
