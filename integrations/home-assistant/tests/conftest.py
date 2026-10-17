# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Loads the integration's plain-Python modules (client, forwarder, const)
without its __init__.py, which needs Home Assistant."""

import sys
import types
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "custom_components" / "senseplane"
if "senseplane" not in sys.modules:
    module = types.ModuleType("senseplane")
    module.__path__ = [str(PKG)]
    sys.modules["senseplane"] = module
