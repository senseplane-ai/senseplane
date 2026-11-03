# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Eyes and ears for your agent: the Python SDK for the Senseplane API.

    from senseplane import Senseplane

    sp = Senseplane(api_key="...")  # or SENSEPLANE_API_KEY; base_url for your own instance
    src = sp.sources.create(name="Front door", type="browser")
    sp.watches.create(instruction="Tell me if a package is left at the front door", sources=[src.id])
    for ev in sp.events.list(source=src.id):
        print(ev.summary)

`AsyncSenseplane` is the same API with `await` and `async for`. Models are in
`senseplane.types` (generated from spec/openapi.yaml); agent tools are in `senseplane.tools`.
"""

from ._async_client import AsyncSenseplane, AsyncSenseplaneDemo, ConversationEvent
from ._base import DEFAULT_BASE_URL, ServerSentEvent
from ._errors import (
    APIConnectionError,
    AuthenticationError,
    ConflictError,
    ErrorCode,
    InternalServerError,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    SenseplaneError,
    WebhookVerificationError,
)
from ._generated.api import KNOWN_SENSES, KnownSense
from ._sync_client import Senseplane, SenseplaneDemo
from ._version import __version__
from ._webhooks import sign_webhook, verify_webhook, verify_webhook_payload
from .labels import LABELS, Label, LabelInfo, detection_label, is_label, label_name
from .senses import (
    SENSES,
    UNIT_SYMBOLS,
    ReadingKind,
    SenseInfo,
    is_sensor_sense,
    reading_text,
    sense_info,
    sense_name,
    state_word,
    unit_symbol,
)

__all__ = [
    "DEFAULT_BASE_URL",
    "KNOWN_SENSES",
    "LABELS",
    "SENSES",
    "UNIT_SYMBOLS",
    "APIConnectionError",
    "AsyncSenseplane",
    "AsyncSenseplaneDemo",
    "AuthenticationError",
    "ConflictError",
    "ConversationEvent",
    "ErrorCode",
    "InternalServerError",
    "KnownSense",
    "Label",
    "LabelInfo",
    "NotFoundError",
    "PermissionDeniedError",
    "RateLimitError",
    "ReadingKind",
    "SenseInfo",
    "Senseplane",
    "SenseplaneDemo",
    "SenseplaneError",
    "ServerSentEvent",
    "WebhookVerificationError",
    "__version__",
    "detection_label",
    "is_label",
    "is_sensor_sense",
    "label_name",
    "reading_text",
    "sense_info",
    "sense_name",
    "sign_webhook",
    "state_word",
    "unit_symbol",
    "verify_webhook",
    "verify_webhook_payload",
]
