// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Trace context over WebSocket signalling (ADR 0033): a traceparent sent in a
// request frame becomes the parent of the media node's span for that request.
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, control, joinToken, publisherGrants, startMedia } from "./testkit.js";

const exporter = new InMemorySpanExporter();

describe("signalling trace propagation", () => {
  let media: Awaited<ReturnType<typeof startMedia>>;

  beforeAll(async () => {
    const cm = new AsyncLocalStorageContextManager();
    cm.enable();
    context.setGlobalContextManager(cm);
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    media = await startMedia();
    await control(media.base, "POST", "/control/rooms", { roomId: "sp-src_1" });
  });
  afterAll(async () => {
    await media?.close();
    trace.disable();
    propagation.disable();
    context.disable();
  });

  it("parents join and later requests on the capture page's traceparent", async () => {
    exporter.reset();
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const clientSpan = "00f067aa0ba902b7";
    const c = new Client(media.ws);
    const r = await c.request("join", { protocolVersion: 1, token: joinToken({ room: "sp-src_1", identity: "src_1:capture", grants: publisherGrants() }), traceparent: `00-${traceId}-${clientSpan}-01` });
    expect(r.ok).toBe(true);
    await c.request("createTransport", { direction: "send" });
    c.close();
    const spans = exporter.getFinishedSpans();
    const join = spans.find((s) => s.name === "media.signal.join")!;
    const create = spans.find((s) => s.name === "media.signal.createTransport")!;
    expect(join.spanContext().traceId).toBe(traceId);
    expect(join.parentSpanContext?.spanId).toBe(clientSpan);
    expect(join.attributes["senseplane.room"]).toBe("sp-src_1");
    // No traceparent on the second request: it continues the join's trace.
    expect(create.spanContext().traceId).toBe(traceId);
    expect(create.parentSpanContext?.spanId).toBe(join.spanContext().spanId);
  });

  it("marks failed requests as errors without the token in the span", async () => {
    exporter.reset();
    const c = new Client(media.ws);
    await c.join("not-a-token");
    const join = exporter.getFinishedSpans().find((s) => s.name === "media.signal.join")!;
    expect(join.status.code).toBe(2);
    expect(JSON.stringify(join.attributes)).not.toContain("not-a-token");
  });
});
