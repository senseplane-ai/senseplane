# Media contract

The one contract between the Senseplane API and a media plane (ADR 0049). The
open-source `media/` server implements it, and any other media plane can too.
The API cannot tell them apart: it speaks only what is
written here, over the network, and changes nothing but configuration
(`MEDIA_CONTROL_URL`, `MEDIA_SIGNING_KEY`, `MEDIA_ISSUER`).

There is one version of this contract. It is updated in place; there are no
versioned routes, and the signalling protocol stays at `protocolVersion: 1`.

## Files

| File | What |
|---|---|
| `control-api.yaml` | The control API (`/control/*`): rooms, participants, egress, health, usage |
| `signalling.md`, `signalling.json` | The WebSocket signalling protocol, the join token's claims and grants |
| `callbacks.json` | Everything the media plane POSTs to the API: room events, feed events, presign and credential requests, the frames batch |
| `whip.md`, `whip.yaml` | WHIP ingest (RFC 9725): the bearer, the authorize callback |
| `tokens.md`, `vectors/tokens.json` | The three token kinds and golden accept/refuse vectors |

## Principles

- **HTTP only between the API and the media plane.** No shared bus, no shared
  database, no shared bucket credentials. The API calls the control API; the
  media plane calls back the URLs the API gave it.
- **The API signs, the media plane verifies.** Join, control and WHIP tokens
  are compact JWS with `alg: EdDSA` (Ed25519) and a `kid`. The media plane
  holds only public keys, as a static ring (`MEDIA_TOKEN_PUBLIC_KEYS`,
  `kid:base64pem` pairs), and checks `iss` against its instance id
  (`MEDIA_INSTANCE_ID`). It fetches nothing and never reads a database.
- **Single use.** Every join and control token's `jti` is consumed when it is
  honoured; a second presentation is refused.
- **Callbacks carry the API's own bearer.** A room's or egress session's
  `callback` is `{ url, token }`. The media plane echoes `token` as
  `Authorization: Bearer` on every callback and signs nothing itself. A
  callback may also carry a W3C `traceparent` header (a sampled frames
  batch, a segment upload); the API continues that trace. Optional.
- **Rooms are plain names.** Senseplane names a camera's room `sp-<source_id>`.
  The media plane treats a room id as an opaque string of at most 200 characters.
- **Roles.** A media plane has an *ingress* side (signalling, WHIP, viewers,
  the control API) and an *egress* side (the camera's continuous feed:
  `segments` and `frames`). How they are deployed is the media plane's
  business; the open-source server runs both in one process by default.

## A camera, end to end

1. At token time (capture page join, bridge config, WHIP authorize) the API
   ensures the camera's room (`POST /control/rooms`, idempotent) with
   `liveness: "any"`, `codecs: ["h264", "opus"]` and room events, and the
   camera's feed (`POST /control/egress` with a `segments` and a `frames` sink,
   idempotent per `sessionId`). Then it mints the join token.
2. The camera joins and produces (signalling or WHIP). Newest replaces old.
3. The egress joins the room as `kind: "egress"` over a plain transport,
   consumes the camera, writes ~6 s fMP4 segments to the API's bucket through
   presigned URLs it asks the callback for, and POSTs a frames batch every
   `batchMs` of the frames sink (the API asks for 200 ms). Each finished segment, run start and end, gap and resolution
   refusal is a feed event.
4. Viewers join with subscribe-only tokens. The media plane enforces
   `subscribeKinds`; the API counts viewers, closes idle ones and meters
   viewing time from room events.

## Object keys

The API's bucket, chosen per request (`keyPrefix`):

- segments: `raw/{account_id}/{source_id}/{yyyy}/{mm}/{dd}/{start_ms}.m4s` (UTC day)
- init segments: `raw/{account_id}/{source_id}/init/{sessionId}.mp4`, and
  `{sessionId}-{run}.mp4` for every run after the first
- clips (written by the API): `clips/{account_id}/...`

## Conformance

`conformance/` in this repository is the black-box suite for this contract.
Run it against any media plane to check it; see `conformance/README.md`.
