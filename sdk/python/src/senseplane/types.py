# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""The API's models, generated from spec/openapi.yaml (Pydantic v2).

The main ones are named after the spec's schemas (Source, Watch, Event, Clip, Grant, …);
inline request and response bodies are named after their path (e.g. InboxGetResponse).
Every model keeps fields it doesn't know (`model_extra`), so a newer API doesn't break it.
"""

from ._generated.models import *  # noqa: F403
