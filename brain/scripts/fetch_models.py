# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Downloads and verifies the pinned model artefacts: `uv run python scripts/fetch_models.py`."""

from senseplane_brain.models import fetch_all

fetch_all()
