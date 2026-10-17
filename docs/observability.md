# Observability

Senseplane emits **OpenTelemetry traces** from every service, keeps **Prometheus
metrics** on each service's `/metrics`, and adds **trace ids to every JSON log
line** written inside a span. Everything is **off by default**; one variable
turns tracing on. Design and privacy rules: [ADR 0033](decisions/0033-opentelemetry.md).

## Turn it on

Set an OTLP endpoint for the services (standard OpenTelemetry variables):

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318   # OTLP/HTTP
```

With Docker Compose, start the bundled Collector, Jaeger and Prometheus too:

```sh
cd deploy/compose
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
  docker compose --profile app --profile observability up -d
```

| UI | Default URL |
|---|---|
| Jaeger (traces) | http://localhost:56686 |
| Prometheus (metrics) | http://localhost:59090 |
| OTLP for anything else on the host | http://localhost:54318 (HTTP), localhost:54317 (gRPC) |

Any OTLP-compatible backend works instead (Grafana Tempo, Honeycomb, Datadog,
SigNoz, an existing Collector...): point `OTEL_EXPORTER_OTLP_ENDPOINT` at it.
Grafana isn't bundled (AGPL); add it yourself if you want dashboards.

### Variables

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | all services | unset (off) | Where traces go. Unset means no SDK is started. |
| `OTEL_SERVICE_NAME` | all services | set per service in compose | `senseplane-api`, `-media`, `-brain`, `-mcp` |
| `OTEL_SDK_DISABLED` | all services | | `true` forces tracing off |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | all services | parent-based, always on | Standard sampling for request traces |
| `OTEL_BSP_SCHEDULE_DELAY` | all services | 5000 | Export batch delay (ms) |
| `SENSEPLANE_TRACE_FRAMES_RATIO` | media | `0.01` | Share of analysis frames traced (0–1). Events are always traced. |
| `VITE_TRACE_SIGNALLING` | console build | unset | `1` makes the capture page send a `traceparent` and its WebRTC connect timings |

Node services load the SDK with `node --import @senseplane/telemetry/register
dist/server.js` (the Docker images and `pnpm start` already do); the brain
sets itself up at start.

## What you'll see

**Traces** (Jaeger → service → operation):

| Trace | Spans |
|---|---|
| A camera event | `media.frame` → `brain.frame` (`brain.signal`, `brain.detect`, `brain.track`, `brain.episode`) → `brain.event.publish` → `consume brain.event` → `webhook.deliver` |
| A watch check | `brain.frame` → `brain.verify` → `vlm verify` (model, tokens, cost) → `brain.event.publish` → ... |
| An agent asking | `mcp.tool look` → `POST /v1/sources/:id/ask` → `rpc.brain.ask` → `vlm ask` |
| A recorded segment | `media.segment.upload` (linked to the session) → `consume media.segment.written` (index, metering) |
| A camera connecting | `media.signal.join` → `media.signal.createTransport` → `media.signal.connectTransport` → `media.signal.produce` (+ client timings when enabled) |

Frames are sampled (1% by default), so most frames have no trace; every
event has one, starting at the frame when that frame was sampled.

**Metrics** (Prometheus, through the Collector), media plane:

| Metric | Meaning |
|---|---|
| `senseplane_media_active_producers`, `senseplane_media_recorders`, `senseplane_media_analysis_feeds` | Live work on the node |
| `senseplane_media_streams_per_worker` | Recordings per live mediasoup worker |
| `senseplane_media_worker_cpu_seconds{worker}`, `senseplane_media_worker_maxrss_bytes{worker}` | mediasoup worker CPU and peak memory |
| `senseplane_media_ffmpeg_rss_bytes{role}` | FFmpeg memory, recorders vs analysis decoders |
| `senseplane_media_segment_upload_seconds`, `..._errors_total`, `senseplane_media_segments_written_total` | Recording to object storage |
| `senseplane_media_analysis_frames_total`, `..._dropped_total`, `senseplane_media_analysis_fps` | Analysis feed health |
| `senseplane_media_ffmpeg_unexpected_exits_total{role}` | FFmpeg crashes |

plus each service's existing metrics (requests, brain frames and events, and
the process defaults).

**Logs:** JSON lines inside a span carry `trace_id` and `span_id`, so a log
line can be looked up as a trace in Jaeger.

## What is never recorded
No frame or audio data, snapshots, prompts, questions, model answers, event
summaries, API keys, tokens or webhook secrets; Postgres spans have no
parameter values. Trace headers never leave the system: webhook
endpoints and model providers receive no `traceparent`. Details in ADR 0033.

## Checking it end to end
`e2e/otel-check.ts` replays the doorstep fixture and asserts, through
Jaeger's API, that one trace connects `media.frame` to `webhook.deliver`
across all three services, that segment uploads (the feed's `segment.written` callbacks) are traced into the indexer,
that the webhook receiver got no `traceparent`, and that no API key or webhook
secret appears in any span.

```sh
# infra + observability under their own project and ports
SP_PG_PORT=35432 SP_VALKEY_PORT=36379 SP_S3_PORT=39000 SP_S3_CONSOLE_PORT=39001 \
SP_OTLP_HTTP_PORT=34318 SP_OTLP_GRPC_PORT=34317 SP_JAEGER_UI_PORT=36686 SP_PROMETHEUS_PORT=39090 \
  docker compose -p senseplane-otel -f deploy/compose/docker-compose.yml --profile observability up -d
pnpm --filter "@senseplane/api..." --filter "@senseplane/media..." build
# a throwaway media key: the API signs with it, the media plane trusts its public half
openssl genpkey -algorithm ed25519 -out /tmp/otel.pem
export MEDIA_SIGNING_KEY="otel-1:$(base64 < /tmp/otel.pem | tr -d '\n')"
export MEDIA_TOKEN_PUBLIC_KEYS="otel-1:$(openssl pkey -in /tmp/otel.pem -pubout | base64 | tr -d '\n')"
export VALKEY_URL=redis://:dev-valkey@localhost:36379
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:34318 OTEL_BSP_SCHEDULE_DELAY=1000
(cd api && OTEL_SERVICE_NAME=senseplane-api PORT=38080 \
  DATABASE_URL=postgres://senseplane_app:senseplane_app@localhost:35432/senseplane \
  MIGRATION_DATABASE_URL=postgres://senseplane:senseplane@localhost:35432/senseplane \
  MEDIA_CONTROL_URL=http://localhost:38090 API_CALLBACK_URL=http://localhost:38080 \
  CAPTURE_URL=http://localhost:5173/capture.html API_PUBLIC_URL=http://localhost:38080 \
  S3_ENDPOINT=http://localhost:39000 S3_BUCKET=senseplane S3_ACCESS_KEY_ID=senseplane S3_SECRET_ACCESS_KEY=senseplane-secret \
  node --import @senseplane/telemetry/register dist/server.js &)
(cd media && OTEL_SERVICE_NAME=senseplane-media SENSEPLANE_TRACE_FRAMES_RATIO=1 PORT=38090 \
  MEDIA_URL=ws://localhost:38090/ MEDIA_DEV_REPLAY=1 \
  node --import @senseplane/telemetry/register dist/server.js &)
(cd brain && OTEL_SERVICE_NAME=senseplane-brain PORT=38070 uv run python -m senseplane_brain &)
cd e2e && E2E_CREATE_ACCOUNT="cd ../api && DATABASE_URL=postgres://senseplane:senseplane@localhost:35432/senseplane node dist/cli.js create-account 'OTel e2e'" \
  node otel-check.ts
```
