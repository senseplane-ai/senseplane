# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""OpenTelemetry for the brain (ADR 0033).

Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set; the API calls below are cheap
no-ops then. Trace context arrives as a `traceparent` field (frames and
requests from the API, on Valkey) and leaves in the `traceparent` field of
every event the brain publishes, so one trace runs API → brain → API → webhook.

Spans carry ids, labels, scores, timings, model names and token counts only:
never frames, audio, prompts, questions or model answers.
"""

import contextlib
import contextvars
import os
from collections.abc import Callable
from typing import Any, TypeVar

from opentelemetry import propagate, trace
from opentelemetry.context import Context
from opentelemetry.trace import SpanKind, Status, StatusCode

__all__ = ["SpanKind", "Status", "StatusCode", "enabled", "setup", "tracer", "extract", "inject", "has_remote_parent", "log_ids", "in_context", "child_span"]

T = TypeVar("T")


def enabled(env: os._Environ | dict = os.environ) -> bool:
    return bool(env.get("OTEL_EXPORTER_OTLP_ENDPOINT") or env.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")) and env.get("OTEL_SDK_DISABLED") != "true"


def setup(service: str = "senseplane-brain") -> bool:
    """Installs the SDK with an OTLP/HTTP exporter (configured by OTEL_* env vars)."""
    if not enabled():
        return False
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", service)}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    return True


def tracer() -> trace.Tracer:
    return trace.get_tracer("senseplane.brain")


def extract(headers: dict | None) -> Context:
    carrier = {k: v for k in ("traceparent", "tracestate") if headers and (v := headers.get(k))}
    return propagate.extract(carrier)


def has_remote_parent(ctx: Context) -> bool:
    return trace.get_current_span(ctx).get_span_context().is_valid


def inject(ctx: Context | None = None) -> dict[str, str]:
    carrier: dict[str, str] = {}
    propagate.inject(carrier, context=ctx)
    return carrier


def log_ids() -> dict[str, str]:
    sc = trace.get_current_span().get_span_context()
    return {"trace_id": format(sc.trace_id, "032x"), "span_id": format(sc.span_id, "016x")} if sc.is_valid else {}


def child_span(name: str, **kwargs: Any):
    """A span only inside an existing trace: per-frame stages of unsampled frames stay untraced."""
    if trace.get_current_span().get_span_context().is_valid:
        return tracer().start_as_current_span(name, **kwargs)
    return contextlib.nullcontext(trace.INVALID_SPAN)


def in_context(fn: Callable[..., T]) -> Callable[..., T]:
    """Binds fn to the current context, for run_in_executor (threads don't inherit contextvars)."""
    ctx = contextvars.copy_context()

    def run(*args: Any) -> T:
        return ctx.run(fn, *args)

    return run
