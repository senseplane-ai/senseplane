# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from senseplane import Senseplane, WebhookVerificationError, sign_webhook, verify_webhook

# Made by the TypeScript SDK's signWebhook and verifyWebhook (scripts/webhook-vectors.mjs).
VECTORS: dict[str, Any] = json.loads((Path(__file__).parent / "fixtures" / "webhook-vectors.json").read_text())


@pytest.mark.parametrize("v", VECTORS["vectors"], ids=[v["name"] for v in VECTORS["vectors"]])
def test_matches_the_typescript_sdk(v: dict[str, Any]) -> None:
    if v["outcome"] == "valid":
        event = verify_webhook(v["body"].encode(), v["header"] or None, VECTORS["secret"], now=v["now"])
        assert event.id == json.loads(v["body"])["id"]
    else:
        with pytest.raises(WebhookVerificationError) as info:
            verify_webhook(v["body"], v["header"] or None, VECTORS["secret"], now=v["now"])
        assert str(info.value) == v["outcome"]


def test_signs_like_the_typescript_sdk() -> None:
    s = VECTORS["sign"]
    assert sign_webhook(s["body"], VECTORS["secret"], s["timestamp"]) == s["header"]


def test_round_trips_and_takes_framework_headers() -> None:
    body = json.dumps({"id": "evt_1", "type": "detection.person", "source": {"id": "src_1", "sense": "video"}})
    sig = sign_webhook(body, "whsec_test")
    headers = {"Content-Type": "application/json", "senseplane-signature": sig}
    assert verify_webhook(body, headers, "whsec_test").id == "evt_1"
    assert verify_webhook(body, [sig], "whsec_test").type == "detection.person"
    assert Senseplane(api_key="k").webhooks.verify(body, sig, "whsec_test").id == "evt_1"
    with pytest.raises(WebhookVerificationError, match="missing"):
        verify_webhook(body, {"other": "x"}, "whsec_test")
    with pytest.raises(WebhookVerificationError, match="tolerance"):
        verify_webhook(body, sign_webhook(body, "whsec_test", 1_000), "whsec_test", now=2_000)
    assert verify_webhook(
        body, sign_webhook(body, "whsec_test", 1_000), "whsec_test", now=2_000, tolerance_seconds=1_000
    )
