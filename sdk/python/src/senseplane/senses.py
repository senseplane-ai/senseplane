# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

# The known sensor senses (spec/senses.json, ADR 0060), as sdk/typescript's senses.ts.
from __future__ import annotations

import math
from typing import Any

from ._generated.senses import SENSES, UNIT_SYMBOLS, ReadingKind, SenseInfo

__all__ = [
    "SENSES",
    "UNIT_SYMBOLS",
    "ReadingKind",
    "SenseInfo",
    "is_sensor_sense",
    "reading_text",
    "sense_info",
    "sense_name",
    "state_word",
    "unit_symbol",
]

_BY_SENSE = {s.sense: s for s in SENSES}


def sense_info(sense: str) -> SenseInfo | None:
    """The catalog entry of a known sensor sense, else None."""
    return _BY_SENSE.get(sense)


def is_sensor_sense(sense: str) -> bool:
    """video and audio are camera senses, and control (switching devices, ADR 0067) is a permission; every other sense is a sensor's."""
    return sense not in ("video", "audio", "control")


def sense_name(sense: str) -> str:
    """What people read for a sense ("door or window", "power use"); unknown ones read as words."""
    s = _BY_SENSE.get(sense)
    return s.name if s else sense.replace("_", " ")


def state_word(sense: str, value: bool) -> str:
    """The word for a state's value: contact True -> "open", switch False -> "off"; unknown senses read on/off."""
    s = _BY_SENSE.get(sense)
    word = (s.on if value else s.off) if s else None
    return word or ("on" if value else "off")


def unit_symbol(unit: str) -> str:
    """How a unit is shown: celsius -> °C, watt -> W; unknown units as they are."""
    return UNIT_SYMBOLS.get(unit) or unit.replace("_", " ")


def js_round(x: float) -> float:
    """Math.round: halves go up (Python's round() goes to even), so both SDKs word values alike."""
    return float(math.floor(x + 0.5))


def _num(n: float) -> str:
    # JavaScript's number formatting: 21.0 is "21".
    return str(int(n)) if float(n).is_integer() else repr(n)


def reading_text(r: Any) -> str:
    """A reading in a few words: "21.5 °C", "open", "pressed (double)". Takes a Reading or its dict."""

    def get(key: str) -> Any:
        return r.get(key) if isinstance(r, dict) else getattr(r, key, None)

    sense, value, unit, state, detail = get("sense"), get("value"), get("unit"), get("state"), get("detail")
    sense = str(getattr(sense, "root", sense))
    kind = get("kind") or ("state" if isinstance(value, bool) else "event" if value is None else "number")
    if kind == "state":
        return str(state) if state else state_word(sense, value is True)
    if kind == "event":
        verb = "rang" if sense == "doorbell" else "pressed" if sense == "button" else "happened"
        return f"{verb} ({detail})" if detail else verb
    text = _num(js_round(value * 10) / 10) if isinstance(value, (int, float)) else str(value)
    sym = unit_symbol(unit) if unit else ""
    return f"{text}%" if sym == "%" else f"{text} {sym}" if sym else text
