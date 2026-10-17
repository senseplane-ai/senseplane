// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Tracing helpers shared by the Node services (ADR 0033). Everything here is a
// no-op until the SDK is started by `--import @senseplane/telemetry/register`,
// which only happens when OTEL_EXPORTER_OTLP_ENDPOINT is set.
//
// Privacy: spans carry ids, counts, timings and error codes only, never frame
// or audio data, prompts, model answers, tokens or secrets.
import { suppressTracing } from "@opentelemetry/core";
import {
  type Context,
  type Link,
  ROOT_CONTEXT,
  type Span,
  type SpanOptions,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from "@opentelemetry/api";

export { SpanKind, SpanStatusCode, context, trace, type Context, type Span } from "@opentelemetry/api";

/** Runs fn with tracing suppressed: no spans, and no trace headers injected into outgoing requests. */
export function untraced<T>(fn: () => T): T {
  return context.with(suppressTracing(context.active()), fn);
}

/** True when traces are exported (the one switch: an OTLP endpoint, unless OTEL_SDK_DISABLED=true). */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) && env.OTEL_SDK_DISABLED !== "true";
}

export const tracer = () => trace.getTracer("senseplane");

type Attrs = Record<string, string | number | boolean | undefined>;

function clean(attrs?: Attrs) {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * Runs fn inside a new active span and ends it, recording failures.
 * `parent` overrides the current context (for work resumed from a message).
 */
export async function withSpan<T>(
  name: string,
  opts: Omit<SpanOptions, "attributes"> & { attributes?: Attrs; parent?: Context },
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const { parent, attributes, ...rest } = opts;
  return tracer().startActiveSpan(name, { ...rest, attributes: clean(attributes) }, parent ?? context.active(), async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error)?.message?.slice(0, 200) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Starts a span that the caller ends (for lifetimes such as an FFmpeg process). */
export function startSpan(name: string, opts: Omit<SpanOptions, "attributes"> & { attributes?: Attrs; parent?: Context } = {}): Span {
  const { parent, attributes, ...rest } = opts;
  return tracer().startSpan(name, { ...rest, attributes: clean(attributes) }, parent ?? context.active());
}

/** Minimal header interface shared by message headers and plain objects. */
export interface HeaderSetter {
  set(key: string, value: string): void;
}
export interface HeaderGetter {
  get(key: string): string | undefined | null;
}

/** Writes W3C traceparent/tracestate for ctx into headers (Valkey message fields, signalling frames...). */
export function injectContext(headers: HeaderSetter, ctx: Context = context.active()): void {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  for (const [k, v] of Object.entries(carrier)) headers.set(k, v);
}

/** Reads a context from headers; returns the root context when none is present. */
export function extractContext(headers: HeaderGetter | undefined | null): Context {
  if (!headers) return ROOT_CONTEXT;
  return propagation.extract(ROOT_CONTEXT, headers, {
    keys: () => ["traceparent", "tracestate"],
    get: (h, key) => (h as HeaderGetter).get(key) ?? undefined,
  });
}

/** The current traceparent string, if a sampled or recording span is active. */
export function currentTraceparent(ctx: Context = context.active()): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  return carrier.traceparent;
}

/** A context from a bare traceparent string (e.g. sent by the capture page in a signalling frame). */
export function contextFromTraceparent(traceparent: unknown): Context {
  if (typeof traceparent !== "string" || !/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(traceparent)) return ROOT_CONTEXT;
  return extractContext({ get: (k) => (k === "traceparent" ? traceparent : undefined) });
}

/** A link to the span in ctx, for long-lived work (a recorder) that starts many short traces. */
export function linksTo(...ctxs: (Context | undefined)[]): Link[] {
  const links: Link[] = [];
  for (const c of ctxs) {
    const sc = c ? trace.getSpanContext(c) : undefined;
    if (sc && trace.isSpanContextValid(sc)) links.push({ context: sc });
  }
  return links;
}

/** Pino/Fastify logger mixin: adds trace_id and span_id to every log line inside a span. */
export function logMixin(): Record<string, string> {
  const sc = trace.getSpanContext(context.active());
  return sc && trace.isSpanContextValid(sc) ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
}

/** Head sampling for high-volume roots (analysis frames): ratio from env, 0–1. */
export function sampleRatio(envName: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env[envName]);
  return Number.isFinite(v) && v >= 0 && v <= 1 && env[envName] !== undefined && env[envName] !== "" ? v : fallback;
}
