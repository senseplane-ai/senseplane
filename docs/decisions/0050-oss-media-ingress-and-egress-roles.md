# 50. The open-source media server: ingress and egress roles, nothing else

Date: 2026-10-17 · Status: accepted · Amends ADR 0002, 0010, 0015, 0034, 0042

## Context

ADR 0049 makes `spec/media` the one contract between the API and any media
plane. The open-source server must implement exactly that contract, so a
self-hosted install behaves like any other media plane that implements it,
and so the conformance suite can be pointed at either.

## Decision

`media/` is one image with two roles, selected by `MEDIA_ROLES` (default
`ingress,egress`, one process):

- **ingress**: rooms and participants (`rooms.ts`), the signalling WebSocket,
  WHIP, and the control API, all on one listener (`PORT`, 8090). The control
  API is authenticated by control tokens, not by the network, so there is no
  separate control port.
- **egress**: the camera feed (`egress/`). It is a participant: it joins the
  room with the join token from the egress request over the ordinary
  signalling protocol (`kind: "egress"`, `transport: "plain"`), consumes the
  camera onto plain RTP transports aimed at its own ffmpeg, and follows every
  publisher of the room. With split roles, the ingress dispatches egress jobs
  over HTTP to `MEDIA_EGRESS_URL` (shared `MEDIA_EGRESS_SECRET`); the egress
  host needs no mediasoup at all.

What changed for Senseplane's camera behaviour, and what did not:

| Kept | How |
|---|---|
| H.264 only, nothing transcoded (ADR 0012) | rooms are created with `codecs: ["h264", "opus"]`; VP8 is refused by the Router |
| 6 s fMP4 segments, `raw/...` key layout | the `segments` sink, `keyPrefix` from the API |
| Resolution refusal before storage (ADR 0022) | the init segment is probed before any upload; frames are held back too |
| Last segment kept when a publisher vanishes | `q`, then a few RTP packets to wake ffmpeg's demuxer, then SIGINT |
| Newest replaces old | the join gate, for every identity; RTMP-style `ingress` over `plain` refuses |
| Viewer audio gating | `subscribeKinds`, enforced on `joined`, `producerAppeared` and `consume` |
| WHIP for cameras, OBS and the bridge | bearer JWT + `authorize_url`; Location `/whip/{session}` |
| Loopback and compose-network candidates | `MEDIA_INTERNAL_ADDRESS` adds a second candidate set |

Removed: the NATS connection (media events, the frames feed, source config),
the bucket credentials (`S3_*`), the service token, the JWKS fetch,
`/ingest-sessions`, `/sources/*/keyframe`, `/sources/*/disconnect`,
`/live-sessions*`, node-side `keepAlive`, idle close, viewer counting and the
active-source check. Privacy masks moved to the API (it masks the frames
batch). The dev replay publisher now takes a join token and plays a file as
that participant.

The frames feed is JPEG (the contract's format), so the image's LGPL ffmpeg
gains the MJPEG encoder and the `image2pipe` muxer.

## Consequences

- A self-hosted install needs one key pair (`init-secrets.sh` writes the API's
  `MEDIA_SIGNING_KEY` and the media server's `MEDIA_TOKEN_PUBLIC_KEYS`).
- Splitting ingress and egress needs no code change, only configuration.
- The media server's state (rooms, single-use token ids) is in memory: one
  ingress process per deployment. A multi-node media plane implements the
  same contract with shared state.
