# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""The known sensor senses, from spec/senses.json (copied into the spec package by
`pnpm codegen`; ADR 0060): numbers in a unit, on/off states (`on` is what true
means) and events."""

import json
from pathlib import Path

_DOC = json.loads((Path(__file__).parent / "spec" / "senses.json").read_text())
ROWS: list[dict] = _DOC["senses"]
UNITS: dict[str, str] = _DOC["units"]

KIND: dict[str, str] = {r["sense"]: r["kind"] for r in ROWS}
UNIT: dict[str, str] = {r["sense"]: r["unit"] for r in ROWS if r.get("unit")}
ON: dict[str, str] = {r["sense"]: r["on"] for r in ROWS if r.get("on")}
OFF: dict[str, str] = {r["sense"]: r["off"] for r in ROWS if r.get("off")}
WORDS: dict[str, list[str]] = {r["sense"]: [w.lower() for w in r.get("words", [])] for r in ROWS}


def is_sensor(sense: str) -> bool:
    """video and audio are camera senses; every other sense is a sensor's."""
    return sense not in ("video", "audio")


def describe() -> str:
    """One line per known sense for the compiler prompt: "contact (state: true=open, false=closed)"."""
    out = []
    for r in ROWS:
        if r["kind"] == "number":
            out.append(f"{r['sense']} (number, {r['unit']})")
        elif r["kind"] == "state":
            out.append(f"{r['sense']} (state: true={r['on']}, false={r['off']})")
        else:
            out.append(f"{r['sense']} (event)")
    return "; ".join(out)
