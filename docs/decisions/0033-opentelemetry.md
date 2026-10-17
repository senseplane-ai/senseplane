# 33. OpenTelemetry across every service

Date: 2026-10-16 · Status: accepted · The NATS rows are superseded by ADR 0051 (Valkey) and the media callbacks (ADR 0049)

## Context
Following one camera event across the system meant reading four services'
logs side by side: media (signalling, recorder, analysis decoder), brain
(perception, watches, model calls), API (indexer, events, webhooks) and MCP.

## Decision
**Traces with OpenTelemetry, context carried everywhere work crosses a boundary:**

| Boundary | How the context travels |
|---|---|
| HTTP (MCP → API, API → media control, S3) | W3C `traceparent`, by the HTTP/undici/Fastify instrumentations |
| WebSocket signalling | optional `traceparent` field in a request frame (spec/media/signalling.md); later requests continue the join's trace |
| NATS (JetStream events, core frames, request/reply) | `traceparent`/`tracestate` message headers, injected by every publisher and extracted by every consumer |
| Brain thread pool | the context is copied into executor threads |

What is traced:
- **Media:** one span per signalling request; one span per FFmpeg process
  lifetime (exit code, signal); one short trace per recorded segment upload,
  linked to the session; analysis frames by head sampling
  (`SENSEPLANE_TRACE_FRAMES_RATIO`, default 1%).
- **Brain:** sampled frames continue the media trace through `brain.signal`,
  `brain.detect`, `brain.track`, `brain.episode`. **Every event is traced**: as a
  child of its frame when that frame was sampled, otherwise as the root of its
  own trace. Watch verification and every model call (`vlm <purpose>`, with
  model, tokens, cost) are spans; NATS requests from the API are server spans.
- **API:** HTTP routes and Postgres queries (auto), one consumer span per NATS
  message, one client span per brain request, `webhook.deliver` as a child of
  the event's trace (an in-memory map from event to context; after a restart
  or for a late retry the delivery starts its own trace), demo session spans.
- **MCP:** one span per tool call.
- **Capture page:** off by default; with `VITE_TRACE_SIGNALLING=1` it sends a
  `traceparent` with `join` and its WebRTC connect timings with `produce`. No
  browser telemetry SDK.

So one trace runs **media.frame → brain.frame → brain.event.publish →
consume brain.event → webhook.deliver**, and **mcp.tool → API route →
rpc.brain.ask → vlm ask**. A segment's trace runs from
**media.segment.upload** to the API's **consume media.segment.written**. A
recording that runs for days is not one giant trace: segments and frames are
short traces linked to the session.

**Metrics stay on each service's Prometheus `/metrics`** (prom-client, and
prometheus_client in the brain). The Collector scrapes them and re-exports
them with any OTLP metrics, so there is one metrics implementation per
service. New media metrics: active producers, streams per worker, recorders
and analysis feeds, FFmpeg RSS by role, segment upload latency, errors and
count, analysis frames, frames per second and dropped frames, unexpected
FFmpeg exits, and mediasoup worker CPU and peak memory.

**Logs:** the existing JSON logs gain `trace_id`/`span_id` on every line
written inside a span (pino mixin in Node, a formatter field in Python).

**Configuration:** standard `OTEL_*` variables. **Off by default:** nothing is
exported unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set (and
`OTEL_SDK_DISABLED` isn't `true`), so self-host stays quiet. Node services load
the SDK with `node --import @senseplane/telemetry/register`; the brain calls
`telemetry.setup()` at start.

**Compose:** an optional `observability` profile with the OpenTelemetry
Collector, Jaeger and Prometheus (all Apache-2.0). Grafana (AGPL) is not
bundled; any OTLP or Prometheus backend works.

## Privacy rules for telemetry
- Spans carry ids, counts, scores, labels, timings, error codes, model names,
  token counts and cost. **Never** frame or audio bytes, snapshots, prompts,
  questions, model answers, event summaries, tokens, API keys, webhook
  secrets or other secrets.
- Account and source ids appear only as the opaque ids the API already uses.
- Postgres spans record query text only, never parameter values.
- **No `traceparent` leaves the system:** webhook deliveries to receivers'
  URLs get no client span and no trace headers, and model calls are not
  HTTP-instrumented, so model providers see no trace ids.
- The Collector config also deletes authorization, cookie and query-string
  attributes as a safety net.
- The e2e check asserts that no API key or webhook secret appears in exported
  spans and that webhook receivers get no `traceparent`.

## Consequences
- One new workspace package (`telemetry/`), and new dependencies, all
  Apache-2.0 or MIT (OpenTelemetry JS and Python, `@fastify/otel`).
- With telemetry on, frame tracing is sampled; raise the ratio only for
  debugging (at 1.0 every analysis frame is a trace).
- The webhook-to-event link is best-effort (in memory), by design: no schema
  change for telemetry.
