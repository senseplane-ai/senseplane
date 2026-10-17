# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Prints the events a fixture produces: `uv run python scripts/events_of.py yolox_tiny doorstep-parcel-640x360.mp4`."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from senseplane_brain.detector import YoloxDetector  # noqa: E402
from senseplane_brain.offline import run_file  # noqa: E402
from senseplane_brain.pipeline import SourcePipeline  # noqa: E402

model, name = sys.argv[1], sys.argv[2]
fixtures = Path(__file__).resolve().parents[2] / "fixtures"
for t, s, p in run_file(str(fixtures / name), SourcePipeline("acc", "src", YoloxDetector(model), None)):
    if s == "brain.event":
        print(f"{t:6.1f} {p['type']:24} {p['confidence']}")
