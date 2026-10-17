# 34. WHIP ingest, and how the bridge reaches it

Date: 2026-10-16 · Status: accepted · Amended by ADR 0049, 0050 (the WHIP bearer is a JWT, authorized through a callback)

## Context

Cameras that push, OBS and the home bridge need a standard way into the media
plane. The browser capture page uses the WebSocket signalling protocol (ADR
0017), which other tools don't speak. WHIP (RFC 9725) is the standard for
pushing WebRTC from encoders and relays, and go2rtc was picked as the
bridge's base.

## Decision

1. **A WHIP endpoint on the media plane's public listener**, `POST /whip/{source_id}`
   (spec/media/whip.yaml, whip.md). It turns the SDP offer into the same
   mediasoup transport and producers as a browser session, so recording,
   the analysis feed, newest-replaces-old, `max_resolution` and source limits
   all apply unchanged. H.264 (packetization-mode 1) and Opus only, never
   transcoded; other video codecs get 415. ICE-lite, non-trickle: `PATCH` returns 405.
2. **Per-source bearer tokens**, created with a `whip` source and rotated or
   revoked through `/v1/sources/{id}/ingest-token`. The API stores a SHA-256
   hash in `ingest_tokens` (RLS, plus an owner-defined lookup function).
3. **The media plane stays database-free.** It asks the API
   (`POST /internal/media/whip-authorize`, service token) to check a bearer
   token; the API answers with an ordinary 10-minute media join token
   (identity `<source>:whip`, kind `ingress`) that the media plane verifies as
   before. Limits, allowances and the audit entry live in the API.
4. **Token fallback in the query string** (`?access_token=`, RFC 6750) for
   clients that cannot set headers. The header is preferred.

## go2rtc cannot publish WHIP

Tested with go2rtc v1.9.14 (darwin/arm64, the latest release): its `publish:`
module only has an RTMP consumer. Both `webrtc:http://…/whip/…` and
`whip:http://…` fail at start-up with
`streams: unsupported scheme: webrtc:http://…` / `…: whip:http://…`
(internal/streams/publish.go). go2rtc can *receive* WHIP and *pull* WHEP, but
not push WHIP.

**So the bridge keeps go2rtc for what it is good at (RTSP/ONVIF/Tapo pulling,
camera quirks) and pushes WHIP with its own small client**,
`bridge/internal/whip` (pion/webrtc, MIT): H.264 access units go in, the same
bytes go out as RTP, nothing is decoded. `bridge/cmd/whip-push` is a dev tool
over it. `media/src/whip-bridge.test.ts` proves the path end to end: go2rtc
serves an RTSP camera, `whip-push` relays it, and the media plane records
gap-free 640×360 H.264 segments.

RTMP into the media plane (planned with push cameras) remains the fallback
for devices that can only do RTMP; the bridge does not need it.

## Consequences

- One recording path for every source type; WHIP adds no media code paths after negotiation.
- WHIP connects depend on the API being reachable (5 s timeout, 503 otherwise).
- No simulcast, trickle ICE or ICE restart in v1; a client that loses
  connectivity POSTs again and the gap is recorded as `media.recording.gap`.
- Not testable headless: OBS (documented in docs/ingest-whip.md).
