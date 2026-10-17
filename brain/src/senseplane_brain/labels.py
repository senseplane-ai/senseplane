# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""The detector's labels, from spec/labels.json (copied into the spec package by
`pnpm codegen`): person, vehicle and animal group COCO classes; every other COCO
class is one everyday object with its own label."""

import json
from pathlib import Path

_DOC = json.loads((Path(__file__).parent / "spec" / "labels.json").read_text())
_ROWS: list[dict] = _DOC["labels"]

LABELS: list[str] = [r["label"] for r in _ROWS]
GROUPS: frozenset[str] = frozenset(r["label"] for r in _ROWS if r.get("group"))  # person, vehicle, animal
OBJECTS: list[str] = [lbl for lbl in LABELS if lbl not in GROUPS]
COCO: dict[int, str] = {c: r["label"] for r in _ROWS for c in r["coco"]}  # COCO class index → label
NAMES: dict[str, str] = {r["label"]: r["name"] for r in _ROWS}
MIN_SCORE: dict[str, float] = {r["label"]: float(r.get("min_score", _DOC["default_min_score"])) for r in _ROWS}
EVENTS: frozenset[str] = frozenset(r["label"] for r in _ROWS if r.get("events", True))  # labels that post detection events
WORDS: dict[str, list[str]] = {r["label"]: [w.lower() for w in r.get("words") or [r["name"]]] for r in _ROWS}


def noun(label: str) -> str:
    """"cup", "teddy bear", "TV"."""
    name = NAMES.get(label, label.replace("_", " "))
    return name if name.isupper() else name.lower()


def phrase(label: str) -> str:
    """"A cup", "An umbrella", "A TV"."""
    n = noun(label)
    return f"{'An' if n[:1].lower() in 'aeiou' else 'A'} {n}"
