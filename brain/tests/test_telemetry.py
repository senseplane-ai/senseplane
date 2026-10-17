# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Trace context through the brain (ADR 0033): frame trace context in, event traceparent out."""

import asyncio
import json
import logging
import threading

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from senseplane_brain import telemetry
from senseplane_brain.logging import JsonFormatter
from senseplane_brain.worker import Worker

EXPORTER = InMemorySpanExporter()
_PROVIDER = TracerProvider()
_PROVIDER.add_span_processor(SimpleSpanProcessor(EXPORTER))
trace.set_tracer_provider(_PROVIDER)

TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
MEDIA_SPAN = "00f067aa0ba902b7"


class FakeSink:
    def __init__(self):
        self.sent: list[tuple[str, dict, dict | None]] = []

    async def publish(self, subject, data, headers=None):
        self.sent.append((subject, json.loads(data), headers))


class StubWorker:
    stats = {"events": 0, "publish_retries": 0, "publish_failed": 0}
    backlog: list = []
    publish = Worker.publish
    send = Worker.send
    retry_backlog = Worker.retry_backlog


@pytest.fixture(autouse=True)
def reset():
    EXPORTER.clear()


def test_off_without_an_endpoint():
    assert telemetry.enabled({}) is False
    assert telemetry.enabled({"OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318"}) is True
    assert telemetry.enabled({"OTEL_EXPORTER_OTLP_ENDPOINT": "http://c:4318", "OTEL_SDK_DISABLED": "true"}) is False


def test_frame_headers_to_event_headers_keep_one_trace():
    ctx = telemetry.extract({"traceparent": f"00-{TRACE_ID}-{MEDIA_SPAN}-01", "sp-meta": "{}"})
    assert telemetry.has_remote_parent(ctx)
    js = FakeSink()
    event = ("brain.event", {"type": "detection.person", "account_id": "acc_1", "source_id": "src_1", "confidence": 0.9, "summary": "x"})
    with telemetry.tracer().start_as_current_span("brain.frame", context=ctx):
        with telemetry.child_span("brain.detect"):
            pass
        asyncio.run(StubWorker().publish(js, [event]))
    subject, payload, headers = js.sent[0]
    assert subject == "brain.event" and payload["type"] == "detection.person"
    assert headers["traceparent"].split("-")[1] == TRACE_ID  # the API's consumer continues this trace
    spans = {s.name: s for s in EXPORTER.get_finished_spans()}
    frame, publish, detect = spans["brain.frame"], spans["brain.event.publish"], spans["brain.detect"]
    assert format(frame.parent.span_id, "016x") == MEDIA_SPAN
    assert publish.parent.span_id == frame.context.span_id
    assert detect.parent.span_id == frame.context.span_id
    assert headers["traceparent"].split("-")[2] == format(publish.context.span_id, "016x")
    assert "summary" not in json.dumps(dict(publish.attributes))  # no event text in spans


def test_unsampled_frames_are_untraced_but_events_still_start_a_trace():
    js = FakeSink()
    with telemetry.child_span("brain.detect") as span:
        assert span is trace.INVALID_SPAN
    asyncio.run(StubWorker().publish(js, [("brain.event", {"type": "sound.detected", "account_id": "a", "source_id": "s", "confidence": None})]))
    names = [s.name for s in EXPORTER.get_finished_spans()]
    assert names == ["brain.event.publish"]
    assert js.sent[0][2]["traceparent"]


def test_context_follows_work_into_executor_threads_and_logs():
    seen = {}
    record = logging.LogRecord("t", logging.INFO, __file__, 1, "hello", None, None)

    def work():
        seen["thread"] = threading.current_thread().name
        seen["ids"] = telemetry.log_ids()
        seen["line"] = json.loads(JsonFormatter().format(record))

    with telemetry.tracer().start_as_current_span("rpc.brain.ask") as span:
        t = threading.Thread(target=telemetry.in_context(work))
        t.start()
        t.join()
        want = format(span.get_span_context().trace_id, "032x")
    assert seen["ids"]["trace_id"] == want
    assert seen["line"]["trace_id"] == want
    assert "trace_id" not in json.loads(JsonFormatter().format(record))  # outside a span: no ids
