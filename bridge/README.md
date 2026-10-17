# bridge

Relays RTSP cameras on a local network to Senseplane, outbound only: no
inbound ports, no port forwarding (ADR 0045).

- Fetches the cameras assigned to its token from the API (`GET /v1/bridge/config`, every 60 s).
- Pulls each camera with go2rtc's RTSP client (MIT, used as a library) and
  pushes the same H.264 over WHIP (`internal/whip`); nothing is re-encoded.
- Reconnects with backoff (1 s doubling to 30 s) when the camera or the media
  connection drops, or the camera sends nothing for 10 s.
- Reports each camera's state (`connecting`, `online`, `reconnecting`,
  `offline`) every 30 s and on every change; the console shows it on the source.

## Run

Create a source with `"type":"rtsp"` (the console's "IP camera"); it returns a
bridge token and this command:

```sh
docker run -d --restart unless-stopped --name senseplane-bridge ghcr.io/senseplane-ai/bridge:0.1 \
  --api https://senseplane.example.com --token brg_… --rtsp rtsp://user:pass@192.168.1.40:554/stream1
```

`--rtsp` claims the camera the token was created for; more `--rtsp` flags (or
sources created with `"bridge_id"`) add cameras to the same bridge.

| Flag | Environment | Purpose |
|---|---|---|
| `--api` | `SENSEPLANE_API_URL` | Your Senseplane API URL |
| `--token` | `SENSEPLANE_BRIDGE_TOKEN` | Bridge token (`brg_…`) |
| `--rtsp` (repeatable) | `SENSEPLANE_RTSP` (comma-separated) | Camera URLs to claim or add |
| `--name` | | Name for a camera added with `--rtsp` |
| `--whip-base` | `SENSEPLANE_WHIP_BASE` | Push to the media plane at this base URL instead of the public one |
| `--listen` | `BRIDGE_LISTEN` | `/healthz` and `/metrics` (default `127.0.0.1:8099`) |

Passwords in RTSP URLs never appear in logs or in what the bridge reports.

## Build and test

```sh
go test ./... && go build -o bin/bridge ./cmd/bridge
docker build -t ghcr.io/senseplane-ai/bridge:dev .   # static binary on distroless, runs as nonroot
```

Layout: `internal/api` (the bridge's API client), `internal/bridge` (config
polling, one relay per camera, health reports), `internal/relay` (pull → push
with reconnects), `internal/camera` (go2rtc RTSP → Annex B access units with
exact durations), `internal/whip` (WHIP client), `internal/health`.

## WHIP client

`internal/whip` pushes an H.264 stream to a WHIP endpoint (RFC 9725) without
re-encoding (pion/webrtc, MIT). The bridge uses it to relay the cameras that
go2rtc pulls, because go2rtc's own `publish:` only supports RTMP (ADR 0034).
`cmd/whip-push` is a dev tool over it:

```sh
go build -o bin/whip-push ./cmd/whip-push
ffmpeg -rtsp_transport tcp -i rtsp://camera/stream -an -c copy -bsf:v dump_extra -f h264 - \
  | WHIP_TOKEN=... bin/whip-push -endpoint https://media.example/whip/src_123 -fps 15
```
