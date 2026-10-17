# 45. Bridge cameras and sensor integrations

Date: 2026-10-16 · Status: accepted

## Context

The console's "Add a camera" flow offers four kinds of source: a phone or
laptop (capture link), an IP camera through the bridge, OBS or any WHIP
client, and Home Assistant sensors. WHIP sources and tokens existed (ADR 0034);
the bridge was a stub, sensors could only push readings with an account API
key, and sensor watches fired `watch.triggered`.

## Decision

### Source types and tokens

| `type` | `ingest` on create | Token | Rotate / revoke |
|---|---|---|---|
| `whip` | `whip_url`, `token` | `whp_…` per source | `POST`/`DELETE /v1/sources/{id}/ingest-token` |
| `rtsp` | `bridge_token`, `bridge_id`, `docker_command` | `brg_…` per **bridge** | same route; re-keys every camera on that bridge |
| `sensor` | `integration_token` | `sit_…` per source | same route |

Every token is shown once and stored as a SHA-256 hash. `ingest.token` carries
the same value in every case, so existing clients keep working.

### Bridges

- A **bridge** row (one device, one token, one account) carries any number of
  `rtsp` sources (`sources.bridge_id`). Creating an `rtsp` source without
  `bridge_id` creates a bridge; with `bridge_id` (and `rtsp_url`) the camera
  joins that bridge and no new token is issued.
- Camera RTSP URLs are stored encrypted with `SECRETS_ENCRYPTION_KEY`
  (AES-256-GCM, ADR 0027) and only ever sent back to the bridge holding the
  token. Error details the bridge reports have credentials removed on both sides.
- Bridge routes (`/v1/bridge/config`, `/cameras`, `/health`) take only a bridge
  token; a bridge token is refused everywhere else in `/v1`.
- `docker run … --token brg_… --rtsp URL` is the single-camera shortcut: the
  bridge calls `POST /v1/bridge/cameras`, which returns the camera with that
  URL, else gives the URL to the oldest camera still waiting for one, else adds
  a camera to the bridge (`source_limit_reached` applies).
- The bridge pushes each camera with **its own bridge token** to the camera's
  WHIP URL; `/internal/media/whip-authorize` accepts a bridge token for that
  bridge's `rtsp` sources only. The media plane is unchanged, and limits,
  allowances and auditing apply as for any WHIP publisher.
- Bridge cameras are **video only**: camera audio is usually AAC, which WebRTC
  can't carry without re-encoding. `record_audio` is ignored for `rtsp`.
- Only H.264 is relayed (ADR 0012); an H.265 or MJPEG camera reports
  "set its stream to H.264".

### The bridge (Go)

- Pulls RTSP with **go2rtc's RTSP client used as a library** (MIT; TCP
  interleaved, its depacketiser handles the usual camera quirks), not a sidecar:
  one static binary, nothing else to run. go2rtc still cannot publish WHIP
  (ADR 0034), so `internal/whip` (pion) pushes the same access units; each is
  held until the next arrives so its duration is the real RTP timestamp distance.
- Per camera: pull, wait for a keyframe, connect WHIP, relay. Any failure
  (camera error, 10 s without video, WHIP connection failed) tears both sides
  down and retries with backoff from 1 s doubling to 30 s, jittered, reset after
  30 s of stable streaming.
- Polls `GET /v1/bridge/config` every 60 s and reconciles: new cameras start,
  removed ones stop, a changed URL restarts that camera. A refused token stops
  every camera (rotated or revoked; restart with the new token).
- Reports `connecting | online | reconnecting | offline` per camera every 30 s
  and on every change. `--whip-base` (or `SENSEPLANE_WHIP_BASE`) points pushes
  at another address of the media plane, for a bridge on the same Docker host.
- Outbound only. `/healthz` and `/metrics` listen on 127.0.0.1 inside the
  container for health checks. Image: multi-stage, static, distroless, nonroot.

### Source status

- `status` gains `reconnecting`, and every source has `status_since` (set by a
  trigger whenever `status` changes); `rtsp` sources show `bridge_id` and
  `status_detail` (why it is reconnecting).
- The media plane stays the authority for online/offline. A bridge report of
  `reconnecting` or `offline` sets the status at once (the camera dropped
  before the WebRTC session times out); when the media plane then reports the
  push offline, a camera whose bridge is reconnecting stays `reconnecting`.
- A bridge silent for 90 s (three heartbeats) has its cameras marked offline by
  the API's 30 s sweep.

### Sensors

- `POST /v1/sources {type: "sensor", senses?: ["temperature","humidity"]}`
  returns an integration token. It can call only `GET /v1/integration` (which
  source am I?), `GET /v1/sources/{its id}` and
  `POST /v1/sources/{its id}/readings`. Readings accept `at` as an alias of
  `measured_at`; a sense the sensor doesn't have is refused.
- Readings stay in the monthly-partitioned `sensor_readings` table (ADR 0005,
  no TimescaleDB). Retention: the sweeper deletes readings older than the
  source's `retention_days`, else the account's; kept forever when both are null.
- Sensor watches ("temperature > 27 for 5 min") are evaluated in the API where
  readings arrive, as before, but now fire **`reading.threshold`** (with
  `watch_id`), once per out-of-range run. `sensor.threshold` remains the event
  for a source's own `sensor_thresholds`. Agents can create watches on sensors
  they hold a temperature or humidity grant for.
- `read_environment` (MCP) already reads the latest readings and the trend
  through `/now` and `/history`; no change.

### Home Assistant

A custom integration (`integrations/home-assistant/custom_components/senseplane`):
config flow with the API URL and an integration token (validated with
`GET /v1/integration`), then the temperature and humidity entities to forward;
an options flow to change them; reauth when the token is refused. State changes
become readings (°F and K converted to °C), batched every 10 s (or 500), kept
up to 5,000 while Senseplane is unreachable and retried with backoff (2 s to
5 min). One config entry per Senseplane sensor source.

## Consequences

- A rotated bridge token re-keys every camera on the bridge at once; the
  bridge must be restarted with the new token (no remote re-pairing yet).
- Integration-token pushes are audited like any authenticated request (one
  entry per batch).
- Sensor watches that relied on `watch.triggered` must subscribe webhooks to
  `reading.threshold`.
- Not yet: ONVIF discovery, pairing codes, remote bridge updates, audio from
  bridge cameras, sensor senses beyond temperature and humidity.

## Addendum (2026-10-16): pause, and WHIP from the same machine

**Pause and resume.** `POST /v1/sources/{id}/pause` sets `status: paused`,
ends the camera's live session (recording and analysis stop with it) and
writes `source.paused` to the audit log; `/resume` sets `offline` until the
publisher connects again (`source.resumed`). While paused, ingest is
**refused**, not kept connected: WHIP and bridge pushes and capture-link joins
get 409 `conflict` with `details.reason: paused`, and `GET /v1/bridge/config`
leaves the camera out, so the bridge stops pulling it within a poll. Refusing
saves the bandwidth and CPU a connected-but-ignored stream would cost, and
there is no half state where video flows but nothing is recorded. Media
offline events, bridge health reports and the silent-bridge sweep never undo
a pause. Sensors can't be paused (409); revoking the integration token stops
them. Pausing is admin work, like adding a camera.

**WHIP publishers on the same machine.** A WHIP push from the bridge or
`whip-push` connected over HTTP but its ICE never completed against a local
stack, so the recorder's FFmpeg received no packets at all and, when the
session ended, reported "Could not find codec parameters … unspecified size"
(the error FFmpeg prints for an input that never delivered a packet). The
media plane announces `MEDIA_ANNOUNCED_ADDRESS` (127.0.0.1 in the compose
default) and pion leaves loopback candidates out unless told, so the checks
went out from the LAN interfaces and the answers came back from addresses ICE
didn't know. The bridge's WHIP client now includes loopback candidates
(`bridge/internal/whip`, regression test against a loopback-only answerer),
and the media plane can announce a second address for peers on its own
network (`MEDIA_INTERNAL_ADDRESS`, `auto` in compose = the container's address,
on `MEDIA_RTC_INTERNAL_PORT`, default RTC port + 100), so a bridge on the
compose network reaches it too. The recorder now logs "no media arrived from
the publisher" when it stops without a packet, instead of FFmpeg's message.

**The open segment at a disconnect.** When a publisher vanished, FFmpeg took
the stop request but its demuxer stayed blocked on the idle UDP input, and the
SIGINT fallback also interrupted FFmpeg's output writes: the open segment (up
to `SEGMENT_SECONDS`) and the playlist were lost on every disconnect. The
recorder now sends each leg a few harmless RTP packets after "q" (sequence
numbers spread over the range, so one is "next" for FFmpeg's reorder queue);
the demuxer returns, FFmpeg ends normally and writes the open segment.
