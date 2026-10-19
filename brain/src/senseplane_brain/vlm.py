# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""One OpenAI-compatible client for every model call (ADR 0008): vision
questions, descriptions and the watch compiler. Configured by environment:
AI_BASE_URL, AI_API_KEY, AI_MODEL_VISION, AI_MODEL_TEXT (AI_MODEL_COMPILE,
AI_MODEL_SUMMARY, AI_MODEL_CHAT override per task): any OpenAI-compatible endpoint, for
example OpenRouter or a local model."""

import base64
import json
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass

import cv2
import numpy as np

from .telemetry import SpanKind, Status, StatusCode, tracer

log = logging.getLogger("senseplane.brain.vlm")


def configured() -> bool:
    return bool(os.environ.get("AI_BASE_URL") and os.environ.get("AI_MODEL_VISION"))


@dataclass
class Answer:
    yes: bool | None
    answer: str
    confidence: float


def _jpeg_data_url(rgb: np.ndarray) -> str:
    ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise RuntimeError("could not encode frame")
    return "data:image/jpeg;base64," + base64.b64encode(jpg.tobytes()).decode()


def _parse_json(text: str) -> dict:
    """The first JSON object in a reply: models sometimes add prose, a code fence or a second object."""
    text = text.strip()
    start = text.find("{")
    if start < 0:
        return json.loads(text)
    out, _ = json.JSONDecoder().raw_decode(text, start)
    return out


class ModelClient:
    """Counts every call through on_call(kind, meta) so usage can be metered.

    `meta` is what the caller passed in (account, purpose: verify/look/ask/
    summary/compile), handed back with the call so concurrent calls are
    attributed correctly (ADR 0025)."""

    def __init__(self, on_call: Callable[[str, dict | None], None] | None = None, on_cost: Callable[[float, dict | None], None] | None = None):
        from openai import OpenAI

        self.client = OpenAI(base_url=os.environ["AI_BASE_URL"], api_key=os.environ.get("AI_API_KEY", "none"), timeout=30, max_retries=1)
        self.vision_model = os.environ["AI_MODEL_VISION"]
        self.text_model = os.environ.get("AI_MODEL_COMPILE") or os.environ.get("AI_MODEL_TEXT") or self.vision_model
        self.summary_model = os.environ.get("AI_MODEL_SUMMARY") or self.vision_model
        # Ask (ADR 0041) needs tool calling; defaults to the text model.
        self.chat_model = os.environ.get("AI_MODEL_CHAT") or os.environ.get("AI_MODEL_TEXT") or self.vision_model
        self.on_call = on_call or (lambda kind, meta=None: None)
        self.on_cost = on_cost or (lambda usd, meta=None: None)
        # Ask OpenRouter for providers that don't retain data (ignored elsewhere). ADR 0008.
        openrouter = "openrouter" in os.environ["AI_BASE_URL"]
        self.extra = {"provider": {"data_collection": "deny"}, "usage": {"include": True}} if openrouter else {}
        self.cost_usd = 0.0  # summed from OpenRouter's usage.cost when present
        self.calls = 0

    def _json(self, model: str, messages: list, kind: str, meta: dict | None = None) -> dict:
        # One client span per model call: model, latency, tokens and cost only, never the prompt,
        # image or answer (ADR 0033). No HTTP instrumentation, so no traceparent goes to the provider.
        with tracer().start_as_current_span(f"vlm {(meta or {}).get('purpose') or kind}", kind=SpanKind.CLIENT, attributes={
            "gen_ai.operation.name": "chat", "gen_ai.request.model": model, "senseplane.purpose": (meta or {}).get("purpose") or kind,
            **({"senseplane.account_id": meta["account"]} if meta and meta.get("account") else {}),
        }) as span:
            try:
                return self._json_untraced(model, messages, kind, meta, span)
            except Exception as err:
                span.set_status(Status(StatusCode.ERROR, type(err).__name__))
                raise

    def _json_untraced(self, model: str, messages: list, kind: str, meta: dict | None, span) -> dict:
        for attempt in (1, 2):
            span.set_attribute("senseplane.attempt", attempt)
            self.on_call(kind, meta)
            kwargs = {"model": model, "messages": messages, "temperature": 0, "extra_body": self.extra or None}
            if attempt == 1:
                kwargs["response_format"] = {"type": "json_object"}
            try:
                resp = self.client.chat.completions.create(**{k: v for k, v in kwargs.items() if v is not None})
                self.calls += 1
                if resp.usage is not None:
                    span.set_attribute("gen_ai.usage.input_tokens", int(resp.usage.prompt_tokens or 0))
                    span.set_attribute("gen_ai.usage.output_tokens", int(resp.usage.completion_tokens or 0))
                if getattr(resp, "model", None):
                    span.set_attribute("gen_ai.response.model", str(resp.model))
                cost = getattr(resp.usage, "cost", None) if resp.usage else None
                if cost is None and resp.usage is not None:
                    cost = (resp.usage.model_extra or {}).get("cost")
                self.cost_usd += float(cost or 0)
                if cost:
                    self.on_cost(float(cost), meta)
                    span.set_attribute("senseplane.cost_usd", float(cost))
                return _parse_json(resp.choices[0].message.content or "")
            except Exception as err:  # unsupported JSON mode or unparsable reply: retry once without it
                log.warning("model call failed (%s), attempt %d: %s", kind, attempt, err)
        raise RuntimeError(f"model call failed twice ({kind})")

    def ask(self, rgb: np.ndarray, question: str, meta: dict | None = None) -> Answer:
        system = ("You look at one frame from a home or small-business camera and answer a question about it. "
                  'Reply with JSON only: {"yes": true|false|null, "answer": "<one short sentence>", "confidence": 0..1}. '
                  "Use yes=null when the question is not a yes/no question. Describe only what is visible; never identify people by name.")
        out = self._json(self.vision_model, [
            {"role": "system", "content": system},
            {"role": "user", "content": [{"type": "text", "text": question}, {"type": "image_url", "image_url": {"url": _jpeg_data_url(rgb)}}]},
        ], "vlm_calls", meta)
        yes = out.get("yes")
        return Answer(yes if isinstance(yes, bool) else None, str(out.get("answer", "")), float(out.get("confidence", 0.0)))

    def describe(self, rgb: np.ndarray, meta: dict | None = None) -> Answer:
        return self.ask(rgb, "Describe what is happening in one short sentence.", meta)

    def compile(self, system: str, user: str, meta: dict | None = None) -> dict:
        return self._json(self.text_model, [{"role": "system", "content": system}, {"role": "user", "content": user}], "llm_calls", meta)

    def chat(self, messages: list, tools: list | None, meta: dict | None = None):
        """One streamed chat turn with tools (Ask, ADR 0041): yields ("delta", text), then ("tool_call", {...}).

        Counted like every other call (one AI check). The span covers the whole stream."""
        from .chat import stream_turn

        span = tracer().start_span("vlm chat", kind=SpanKind.CLIENT, attributes={
            "gen_ai.operation.name": "chat", "gen_ai.request.model": self.chat_model, "senseplane.purpose": (meta or {}).get("purpose") or "chat",
            **({"senseplane.account_id": meta["account"]} if meta and meta.get("account") else {}),
        })
        usage: list = []

        def chunks(stream):
            for chunk in stream:
                if getattr(chunk, "usage", None) is not None:
                    usage.append(chunk.usage)
                yield chunk

        try:
            self.on_call("llm_calls", meta)
            kwargs = {"model": self.chat_model, "messages": messages, "temperature": 0, "stream": True,
                      "stream_options": {"include_usage": True}, "extra_body": self.extra or None, "tools": tools or None}
            stream = self.client.chat.completions.create(**{k: v for k, v in kwargs.items() if v is not None})
            self.calls += 1
            yield from stream_turn(chunks(stream))
            if usage:
                u = usage[-1]
                span.set_attribute("gen_ai.usage.input_tokens", int(u.prompt_tokens or 0))
                span.set_attribute("gen_ai.usage.output_tokens", int(u.completion_tokens or 0))
                cost = getattr(u, "cost", None)
                if cost is None:
                    cost = (getattr(u, "model_extra", None) or {}).get("cost")
                if cost:
                    self.cost_usd += float(cost)
                    self.on_cost(float(cost), meta)
                    span.set_attribute("senseplane.cost_usd", float(cost))
        except Exception as err:
            span.set_status(Status(StatusCode.ERROR, type(err).__name__))
            raise
        finally:
            span.end()

    def probe(self) -> None:
        """Startup check that the vision model accepts images (fails fast)."""
        self.ask(np.zeros((64, 64, 3), dtype=np.uint8), "Is this image completely black?")
