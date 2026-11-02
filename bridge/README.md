# bridge

Relays RTSP cameras on a local network to Senseplane, and sends the Home
Assistant sensors a person chose, outbound only: no inbound ports, no port
forwarding (ADR 0045, 0061).

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
docker run -d --restart unless-stopped --name senseplane-bridge ghcr.io/senseplane-ai/bridge:0.2 \
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
| `--listen` | `BRIDGE_LISTEN` | The status page, `/healthz` and `/metrics` (default `127.0.0.1:8099`) |
| `--ha-url` | `HA_URL` | Read sensors from this Home Assistant (`http://homeassistant.local:8123`); as an add-on the Supervisor's is used |
| `--ha-token` | `HA_TOKEN` | A Home Assistant long-lived access token |
| `--state-dir` | `SENSEPLANE_STATE_DIR` | Without `--token`: pair with a code and keep the token here |
| `--box-name` | `SENSEPLANE_BOX_NAME` | The name a person sees when pairing (default `Home Assistant`) |
| `--matter-url` | `MATTER_URL` | Read Matter devices through this Matter Server (`ws://localhost:5580/ws`) |

Passwords in RTSP URLs never appear in logs or in what the bridge reports.

## Home Assistant

With `--ha-url` and `--ha-token` (or as the Home Assistant add-on), the bridge
reads Home Assistant's websocket API: it lists the entities Senseplane can
take (numbers such as temperature and power, door, motion and leak sensors,
switches, lights and locks, doorbells and buttons; `spec/home-assistant/readings.json`)
with their room, and sends readings only of the ones a person chose in the
console. It never calls a Home Assistant service.

## Matter

With `--matter-url`, the bridge reads Matter devices through a Matter Server
(matterjs-server or python-matter-server, the WebSocket API Home Assistant's
Matter integration uses; run it with host networking). A person adds a device
on the box's page in Senseplane with the code they get by sharing it from its
own app (Apple Home, Google Home, the maker's app); the box commissions it and
its sensors are listed to choose from, like Home Assistant's. The bridge never
sends a device command (ADR 0062).

`MATTER_URL=ws://127.0.0.1:5580/ws go test -run Live ./internal/matter/`
checks the client against a real server and a device in pairing mode (the
matter.js example plug, `matter-device --type=socket`, code 34970112332).

## Pairing with a code

Without `--token`, give it `--state-dir`: the bridge asks Senseplane for a
code, shows it on its status page (`--listen`) and in its log, and waits
while someone enters it in the console (`/link`). It keeps the token it gets
in the state directory (mode 0600) and pairs again only if that token is
refused.

```sh
docker run -d --restart unless-stopped --name senseplane-bridge -v senseplane-bridge:/data -p 127.0.0.1:8099:8099 \
  ghcr.io/senseplane-ai/bridge:0.3 --api https://senseplane.example.com --state-dir /data --listen :8099 \
  --ha-url http://homeassistant.local:8123 --ha-token "$HA_TOKEN"
# open http://localhost:8099 for the code
```

## Build and test

```sh
go test ./... && go build -o bin/bridge ./cmd/bridge
docker build -t ghcr.io/senseplane-ai/bridge:dev .   # static binary on distroless, runs as nonroot
```

Layout: `internal/api` (the bridge's API client), `internal/bridge` (config
polling, one relay per camera, health reports, the Home Assistant link),
`internal/relay` (pull → push with reconnects), `internal/camera` (go2rtc
RTSP → Annex B access units with exact durations), `internal/whip` (WHIP
client), `internal/homeassistant` (websocket client and state → reading
mapping), `internal/sensors` (batched sending with backoff),
`internal/pairing` (codes and the state file), `internal/matter` (a Matter
Server client and the attribute → reading mapping), `internal/health`.

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
