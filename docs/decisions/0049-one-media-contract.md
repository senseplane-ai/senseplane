# 49. One media contract for every media plane

Date: 2026-10-17 · Status: accepted · Amends ADR 0002, 0017, 0034, 0042

## Context

The API should drive the open-source `media/` server and any other media plane
(for example an existing multi-node one) with nothing differing but
configuration: same services, same routing, same contracts, same code paths.
Until now the
API and the open-source media server shared NATS (media events, the frames
feed, source config), a bucket's long-lived credentials and a service token,
and the control API was Senseplane-shaped (`/ingest-sessions`,
`/live-sessions`, keyframe and disconnect). The multi-node media plane speaks a
room-and-participant control API with Ed25519 control tokens, and has no
NATS, no Senseplane bucket and no Senseplane vocabulary.

## Decision

`spec/media` is the one contract. It is updated in place: no version split,
no versioned routes, signalling stays `protocolVersion: 1`. Its wire shapes
follow that room-and-participant plane exactly; where the open-source server did
something else, the open-source server changes.

- **Control API** (`control-api.yaml`): `/control/rooms` (idempotent create
  with `liveness`, `codecs`, `onDuplicateIdentity`, `events` and a
  `callback`), `GET`/`DELETE /control/rooms/{room}`,
  `DELETE /control/rooms/{room}/participants/{identity}` with a `reason`,
  `/control/egress` (idempotent per `sessionId`), `GET /control/healthz`,
  `GET /control/usage`. The room create answers `signal_url`, so the API needs
  no signalling setting.
- **Tokens** (`tokens.md`, golden `vectors/tokens.json`): join (`aud: "media"`),
  control (`aud: "control"`, one per call) and WHIP (`aud: "whip"`) tokens,
  EdDSA with a `kid`, verified against a static public ring
  (`MEDIA_TOKEN_PUBLIC_KEYS`) and the instance id as issuer. Join and control
  tokens are single use. The Senseplane grants (`maxResolution`,
  `subscribeKinds`, `idleTimeoutSeconds`, `maxLiveViewers`,
  `maxActiveSources`) are typed, optional and strict.
- **Callbacks** (`callbacks.json`): the media plane POSTs room events, feed
  events (`source.online/offline`, `segment.written`, `recording.gap`,
  `resolution_rejected`), presign requests and a once-a-second frames batch to
  the URL it was given, echoing the caller's bearer. At least once; receivers
  dedupe on `idempotencyKey`.
- **Feed egress**: one egress session per camera with a `segments` sink (6 s
  fMP4, `raw/...` keys, resolution checked before anything is stored,
  destination the caller's bucket through a presigned PUT per object) and a
  `frames` sink (≤ 5 JPEGs at 640x360 and 1 s of 16 kHz PCM per POST).
- **WHIP** (`whip.md`): the bearer is a signed JWT naming its room and
  `authorize_url`; the ingress calls that URL with the bearer and gets a join
  token. No service secret.
- **Signalling deltas**: `producerAppeared` (was `newProducer`),
  `transportId` in transport replies, plain transports for the egress,
  `requestKeyFrame`, removal reasons passed to `roomClosed`, no `keepAlive`
  and no `source_limit_reached` on the node (the API owns idle close, viewer
  counts and the active-camera limit). Newest replaces old, except an
  `ingress` over a `plain` transport (RTMP), which keeps the refusal.
- **Plain room names** (`sp-<source_id>`) and one signing key per
  deployment. Senseplane meters its own usage from callbacks.
- **The control API is public**: control tokens are signed and single use, so
  the network is not the authentication.

The Senseplane API's media settings are `MEDIA_CONTROL_URL`,
`MEDIA_SIGNING_KEY` (`kid:base64pem`) and `MEDIA_ISSUER`, plus the callback
base it gives the media plane. Deployments differ only in their values.

`conformance/` is the black-box suite for the contract (ADR 0053).

## Consequences

- The open-source media server has no NATS connection and no bucket
  credentials (ADR 0050); the API needs no `MEDIA_SERVICE_TOKEN`.
- Privacy masks are applied by the API to the frames batch before anything
  reaches the brain (they were applied in the media server).
- Live view's idle close, viewer counts and camera-offline grace move to the
  API (ADR 0042 amended); the console tells the API it is watching.
- The WHIP bearer shown to users becomes a JWT; existing `whp_` tokens stop
  working and must be rotated (`POST /v1/sources/{id}/ingest-token`).
- Callback envelopes differ by kind: room events carry `roomId`/`at`, feed
  events `room`/`sessionId`/`sentAt`. Unifying them is a follow-up for every
  implementation, not a Senseplane-only change.
