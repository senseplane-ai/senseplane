# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Model client and LLM compiler against the mock OpenAI-compatible server."""

import json

import numpy as np
import pytest

from senseplane_brain.compiler import compile_watch
from senseplane_brain.vlm import ModelClient

from .mock_openai import MockOpenAI


@pytest.fixture
def env(monkeypatch):
    def use(mock):
        monkeypatch.setenv("AI_BASE_URL", mock.url)
        monkeypatch.setenv("AI_API_KEY", "test")
        monkeypatch.setenv("AI_MODEL_VISION", "vision-model")
        monkeypatch.setenv("AI_MODEL_TEXT", "text-model")
    return use


def test_ask_sends_the_image_and_parses_json(env):
    mock = MockOpenAI(lambda body: (200, '```json\n{"yes": true, "answer": "A box is on the mat.", "confidence": 0.92}\n```'))
    env(mock)
    calls = []
    client = ModelClient(on_call=lambda kind, meta=None: calls.append(kind))
    a = client.ask(np.zeros((36, 64, 3), dtype=np.uint8), "Is there a package?")
    mock.close()
    assert (a.yes, a.answer, a.confidence) == (True, "A box is on the mat.", 0.92)
    req = mock.requests[0]
    assert req["model"] == "vision-model" and req["temperature"] == 0
    assert req["messages"][1]["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert calls == ["vlm_calls"]
    assert client.cost_usd == pytest.approx(0.0001)


def test_retries_without_json_mode_when_the_endpoint_refuses_it(env):
    def handler(body):
        if "response_format" in body:
            return 400, "response_format not supported"
        return 200, '{"yes": false, "answer": "Nothing there.", "confidence": 0.8}'
    mock = MockOpenAI(handler)
    env(mock)
    a = ModelClient().ask(np.zeros((8, 8, 3), dtype=np.uint8), "Q?")
    mock.close()
    assert a.yes is False and len(mock.requests) == 2 and "response_format" not in mock.requests[1]


def test_llm_compile_is_validated_and_falls_back_to_rules(env):
    good = {"trigger": {"type": "objects", "label": "person", "on": "enter", "zone": "front_door"}, "verify": {"prompt": "Is a person at the door?", "min_confidence": 0.8},
            "cooldown_s": 300, "active_hours": None, "vlm_calls_per_day": "5", "warnings": []}
    mock = MockOpenAI(lambda body: (200, json.dumps(good)))
    env(mock)
    c = compile_watch("Tell me when someone comes to the front door", ["front_door"], ["video"], ModelClient())
    mock.close()
    assert c.compiler == "llm" and c.compiled["trigger"]["zone"] == "front_door" and c.estimate == {"vlm_calls_per_day": "5"}

    bad = MockOpenAI(lambda body: (200, json.dumps({"trigger": {"type": "teleport"}})))
    env(bad)
    c = compile_watch("Tell me if a package is left at the front door", ["front_door"], ["video"], ModelClient())
    bad.close()
    assert c.compiler == "rules" and c.compiled["trigger"]["type"] == "sequence"
    assert any("built-in rules" in w for w in c.warnings)


def test_unknown_zone_from_the_llm_is_flagged(env):
    out = {"trigger": {"type": "motion", "zone": "stockroom"}, "cooldown_s": 60, "active_hours": None}
    mock = MockOpenAI(lambda body: (200, json.dumps(out)))
    env(mock)
    c = compile_watch("Anything moves in the stockroom", [], ["video"], ModelClient())
    mock.close()
    assert c.needs_zone and any("stockroom" in w for w in c.warnings)
