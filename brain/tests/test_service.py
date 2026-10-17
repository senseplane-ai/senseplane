# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
import json
import urllib.request

from senseplane_brain.service import BrainService


def test_healthz_and_metrics() -> None:
    svc = BrainService(port=0, host="127.0.0.1").start()
    try:
        base = f"http://127.0.0.1:{svc.port}"
        assert json.load(urllib.request.urlopen(f"{base}/healthz"))["status"] == "ok"
        assert b"senseplane_brain_up 1.0" in urllib.request.urlopen(f"{base}/metrics").read()
    finally:
        svc.stop()
