# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

# The detector's labels (spec/labels.json), as sdk/typescript's labels.ts.
from __future__ import annotations

from typing import TypeGuard

from ._generated.labels import LABELS, Label, LabelInfo

__all__ = ["LABELS", "Label", "LabelInfo", "detection_label", "is_label", "label_name"]

_NAMES = {info.label: info.name for info in LABELS}


def label_name(label: str) -> str:
    """The readable name of a label ("Cup", "Teddy bear").

    Unknown labels read as words ("glass_break" -> "Glass break").
    """
    known = _NAMES.get(label)
    if known:
        return known
    words = label.replace("_", " ")
    return words[0].upper() + words[1:] if words else label


def detection_label(event_type: str) -> str | None:
    """The label of a detection.<label> event type, or None for other types."""
    return event_type[len("detection.") :] if event_type.startswith("detection.") else None


def is_label(label: str) -> TypeGuard[Label]:
    """True for a label the detector reports."""
    return label in _NAMES
