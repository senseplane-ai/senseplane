# @senseplane/media

The open-source media plane (mediasoup). It implements the media contract in
[`spec/media/`](../spec/media) and nothing else (ADR 0049, 0050), so the
Senseplane API cannot tell it from any other media plane that does.

One image, two roles, one process by default:

- **ingress**: the signalling WebSocket (publishers, live viewers, the egress),
  WHIP, and the control API (`/control/*`: rooms, participants, egress,
  healthz, usage).
- **egress**: cameras' continuous feeds. A feed joins the camera's room like any
  participant (`kind: "egress"`, `transport: "pipe"`, here plain RTP on the media plane's own network), writes ~6 s fMP4 segments to the
  caller's bucket through presigned PUTs it asks the callback for, and POSTs
  a frames batch (≤ 5 JPEGs + 1 s of audio) once a second.

It has no message bus, no database and no bucket credentials. Everything
it reports goes to the callback URLs it is given.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 8090 | The one listener: signalling, `/control/*`, `/whip`, `/healthz`, `/metrics` |
| `MEDIA_ROLES` | `ingress,egress` | Which roles this process runs |
| `MEDIA_TOKEN_PUBLIC_KEYS` | — (required for ingress) | Public key ring, `kid:base64pem[,kid:base64pem]` (base64 of an SPKI PEM) |
| `MEDIA_INSTANCE_ID` | `senseplane` | The issuer every token must carry |
| `MEDIA_URL` | `ws://localhost:$PORT/` | The signalling URL clients use (returned as `signal_url`); `wss://…` in production |
| `MEDIA_WORKERS` | min(CPUs, 4) | mediasoup workers |
| `MEDIA_RTC_PORT` | 40000 | WebRTC UDP/TCP port of worker 0 (worker i uses +i) |
| `MEDIA_ANNOUNCED_ADDRESS` | — | IP/host browsers use for WebRTC (LAN IP for phones) |
| `MEDIA_INTERNAL_ADDRESS` | — | `auto` or an IP: extra candidates for peers on the media plane's network (the bridge container) |
| `MEDIA_PLAIN_LISTEN_IP`, `MEDIA_PLAIN_ANNOUNCED_ADDRESS` | `127.0.0.1` | Plain RTP transports (the egress) |
| `MEDIA_PEER_CIDRS` | private ranges | Where a plain transport may send RTP |
| `MEDIA_ROOM_EMPTY_TIMEOUT_SECONDS` | 300 | Default for rooms created without one |
| `MEDIA_EGRESS_URL`, `MEDIA_EGRESS_SECRET` | — | Split roles: the ingress dispatches feeds to this egress host, which needs the same secret |
| `MEDIA_EGRESS_SIGNAL_URL` | `ws://127.0.0.1:$PORT/` | The signalling URL the egress joins rooms through |
| `MEDIA_EGRESS_RTP_IP`, `MEDIA_EGRESS_RTP_ANNOUNCED_ADDRESS` | `127.0.0.1` | Where the egress's ffmpeg listens for RTP |
| `MEDIA_EGRESS_MAX_SESSIONS` | 64 | Feeds per egress host |
| `SENSEPLANE_TRACE_FRAMES_RATIO` | 0.01 | Share of frames batches that start a trace |
| `WHIP_CORS_ORIGINS`, `WHIP_AUTHORIZE_HOSTS` | — | Browser origins for WHIP; optional allow list of `authorize_url` hosts |
| `WHIP_MAX_SESSIONS`, `WHIP_MAX_POSTS_PER_MINUTE` | 200, 30 | WHIP limits |
| `FFMPEG_PATH` | `ffmpeg` | LGPL build in the image (ADR 0015) |
| `MEDIA_DEV_REPLAY` | 0 | `1` enables `POST /dev/replay` (a file played as the participant a join token names; dev/CI only) |
| `LOG_LEVEL` | info | pino level |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_*` | unset (off) | OpenTelemetry tracing ([docs/observability.md](../docs/observability.md)) |

## Tests

`pnpm --filter @senseplane/media test` runs the token vectors, the control API,
signalling, WHIP and the feed egress against a real node (mediasoup and
ffmpeg/ffprobe on PATH). The WHIP bridge test also builds the bridge's Go WHIP
client and pushes real WebRTC; it runs when Go is on PATH (`GO2RTC_PATH` makes
the camera an RTSP stream through go2rtc).

`conformance/` at the repository root checks any media plane against the
contract over the network.

## Load

```sh
pnpm --filter @senseplane/media build && node media/load/run.ts 10 120   # 10 cameras, 2 min
```
