// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contextFromTraceparent, currentTraceparent, extractContext, injectContext, linksTo, logMixin, sampleRatio, telemetryEnabled, withSpan,
} from "./index.js";
import { isWebhookDelivery } from "./sdk.js";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  const cm = new AsyncLocalStorageContextManager();
  cm.enable();
  context.setGlobalContextManager(cm);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
});
afterAll(() => {
  trace.disable();
  propagation.disable();
  context.disable();
});

/** A stand-in for message headers (same get/set shape). */
class Headers {
  private m = new Map<string, string>();
  set(k: string, v: string) { this.m.set(k, v); }
  get(k: string) { return this.m.get(k); }
}

describe("telemetry", () => {
  it("is off unless an OTLP endpoint is set", () => {
    expect(telemetryEnabled({})).toBe(false);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" })).toBe(true);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_SDK_DISABLED: "true" })).toBe(false);
  });

  it("carries a trace across message headers: the consumer's span is a child of the publisher's", async () => {
    exporter.reset();
    const h = new Headers();
    await withSpan("publish media.segment.written", {}, () => injectContext(h));
    expect(h.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    await withSpan("consume media.segment.written", { parent: extractContext(h) }, () => {});
    const [pub, sub] = exporter.getFinishedSpans();
    expect(sub!.spanContext().traceId).toBe(pub!.spanContext().traceId);
    expect(sub!.parentSpanContext?.spanId).toBe(pub!.spanContext().spanId);
  });

  it("carries a trace from a signalling frame's traceparent field", async () => {
    exporter.reset();
    let tp: string | undefined;
    await withSpan("capture.join", {}, () => (tp = currentTraceparent()));
    await withSpan("media.signal.join", { parent: contextFromTraceparent(tp) }, () => {});
    const [client, server] = exporter.getFinishedSpans();
    expect(server!.parentSpanContext?.spanId).toBe(client!.spanContext().spanId);
    expect(contextFromTraceparent("not-a-traceparent")).toBeDefined();
    expect(trace.getSpanContext(contextFromTraceparent("garbage"))).toBeUndefined();
  });

  it("adds trace ids to log lines inside a span and nothing outside", async () => {
    expect(logMixin()).toEqual({});
    await withSpan("x", {}, (span) => {
      expect(logMixin()).toEqual({ trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId });
    });
  });

  it("records failures and links long-lived work", async () => {
    exporter.reset();
    let parent: ReturnType<typeof context.active> | undefined;
    await withSpan("recorder.start", {}, () => (parent = context.active()));
    await expect(withSpan("segment.upload", { links: linksTo(parent) }, () => { throw new Error("s3 down"); })).rejects.toThrow("s3 down");
    const upload = exporter.getFinishedSpans()[1]!;
    expect(upload.status.code).toBe(2);
    expect(upload.links).toHaveLength(1);
  });

  it("never sends a traceparent to webhook URLs", () => {
    expect(isWebhookDelivery("content-type: application/json\r\nsenseplane-delivery: dlv_1\r\n")).toBe(true);
    expect(isWebhookDelivery(["content-type", "application/json", "Senseplane-Delivery", "dlv_1"])).toBe(true);
    expect(isWebhookDelivery("content-type: application/json\r\n")).toBe(false);
  });

  it("reads sampling ratios safely", () => {
    expect(sampleRatio("R", 0.01, {})).toBe(0.01);
    expect(sampleRatio("R", 0.01, { R: "1" })).toBe(1);
    expect(sampleRatio("R", 0.01, { R: "7" })).toBe(0.01);
  });
});
