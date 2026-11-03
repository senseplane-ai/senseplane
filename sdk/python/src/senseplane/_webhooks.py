# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0

# Webhook signatures, the same check as the TypeScript SDK's verifyWebhook:
# Senseplane-Signature is `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from collections.abc import Mapping, Sequence

from ._base import parse
from ._errors import WebhookVerificationError
from ._generated.models import Event

DEFAULT_TOLERANCE_S = 300
SIGNATURE_HEADER = "Senseplane-Signature"


def sign_webhook(body: str | bytes, secret: str, timestamp: int | None = None) -> str:
    """The `Senseplane-Signature` header value for a payload (for tests and local senders)."""
    t = int(time.time()) if timestamp is None else timestamp
    raw = body.encode() if isinstance(body, str) else body
    mac = hmac.new(secret.encode(), f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
    return f"t={t},v1={mac}"


def verify_webhook(
    raw_body: str | bytes,
    signature_header: str | Sequence[str] | Mapping[str, str] | None,
    secret: str,
    *,
    tolerance_seconds: int = DEFAULT_TOLERANCE_S,
    now: int | None = None,
) -> Event:
    """Verifies a webhook delivery and returns the parsed event.

    Pass the raw request body (before any JSON parsing) and the Senseplane-Signature
    header; a framework's headers mapping works too. Raises WebhookVerificationError on a
    bad signature or a timestamp more than `tolerance_seconds` from now.
    """
    header = _header(signature_header)
    if not header:
        raise WebhookVerificationError("missing Senseplane-Signature header")
    parts: dict[str, str] = {}
    for part in header.split(","):
        key, _, value = part.partition("=")
        parts[key.strip()] = value.strip()
    t, v1 = parts.get("t", ""), parts.get("v1", "")
    if not re.fullmatch(r"-?\d+", t) or not v1:
        raise WebhookVerificationError("malformed signature header")
    current = int(time.time()) if now is None else now
    if abs(current - int(t)) > tolerance_seconds:
        raise WebhookVerificationError("timestamp outside tolerance")
    body = raw_body.encode() if isinstance(raw_body, str) else raw_body
    expected = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).digest()
    try:
        given = bytes.fromhex(v1)
    except ValueError:
        given = b""
    if not hmac.compare_digest(given, expected):
        raise WebhookVerificationError("signature mismatch")
    return parse(Event, json.loads(body))


def _header(value: str | Sequence[str] | Mapping[str, str] | None) -> str | None:
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, Mapping):
        for key, v in value.items():
            if key.lower() == SIGNATURE_HEADER.lower():
                return v
        return None
    return value[0] if value else None
