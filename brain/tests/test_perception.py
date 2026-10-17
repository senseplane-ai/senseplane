# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Perception on the fixtures (offline, same framing and detector cascade as the analysis feed):
per-class precision/recall against fixtures/labels.json, person latency."""

import json
from pathlib import Path

import pytest

from senseplane_brain.detector import detectors
from senseplane_brain.offline import run_file
from senseplane_brain.pipeline import SourcePipeline
from senseplane_brain.sound import SoundClassifier

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
LABELS = json.loads((FIXTURES / "labels.json").read_text())["fixtures"]


def label_of(payload: dict) -> str:
    return f"sound:{payload['labels'][0]}" if payload["type"] == "sound.detected" else payload["labels"][0]


@pytest.fixture(scope="module")
def results():
    (det, confirm), snd = detectors(), SoundClassifier()
    out = {}
    for name in LABELS:
        events = run_file(str(FIXTURES / name), SourcePipeline("acc", "src", det, snd, confirm=confirm))
        out[name] = [(t, p) for t, s, p in events if s == "brain.event"]
    return out


def test_precision_recall_per_class(results):
    stats: dict[str, dict[str, int]] = {}
    for name, truth in LABELS.items():
        fired = {label_of(p) for _, p in results[name]}
        expected = {e["label"] for e in truth["expect"]}
        for cls in fired | expected:
            s = stats.setdefault(cls, {"tp": 0, "fp": 0, "fn": 0})
            if cls in expected and cls in fired:
                s["tp"] += 1
            elif cls in expected:
                s["fn"] += 1
            elif cls not in truth["allow"]:
                s["fp"] += 1
    report = {c: {"precision": s["tp"] / max(s["tp"] + s["fp"], 1), "recall": s["tp"] / max(s["tp"] + s["fn"], 1), **s} for c, s in stats.items()}
    print("\nper-class:", json.dumps(report, indent=1))
    for cls in ("person", "vehicle", "animal", "sound:crying"):
        assert report[cls]["recall"] == 1.0, cls
        assert report[cls]["precision"] == 1.0, cls


def test_person_event_within_two_seconds_of_entering(results):
    entered = next(e["from"] for e in LABELS["doorstep-parcel-640x360.mp4"]["expect"] if e["label"] == "person")
    fired_at = min(t for t, p in results["doorstep-parcel-640x360.mp4"] if p["type"] == "detection.person")
    assert fired_at - entered <= 2.0, f"person event {fired_at - entered:.1f} s after entering"


def test_events_carry_snapshots_and_episodes_close(results):
    person = next(p for _, p in results["doorstep-parcel-640x360.mp4"] if p["type"] == "detection.person")
    assert person["snapshot_jpeg_b64"].startswith("/9j/")  # JPEG
    assert person["summary"] == "A person was seen."
