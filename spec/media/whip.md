# WHIP ingest (RFC 9725)

Cameras, OBS and the bridge publish with WHIP. A WHIP publish is a participant
like any other: the ingress turns the SDP offer into `join` →
`createTransport(send)` → `connectTransport` → `produce` on the media plane,
and the camera then does ICE and DTLS with the media plane directly. Nothing
is transcoded. Machine-readable: [`whip.yaml`](whip.yaml).

## The bearer

The WHIP bearer is a JWT the API signed (`aud: "whip"`, `tokens.md`) naming
the camera's `room`, an `authorize_url` and a `jti`, usually without `exp`.
`POST /v1/sources` with `type: "whip"` returns it with `ingest.whip_url`
(shown once); `POST /v1/sources/{id}/ingest-token` rotates it and `DELETE`
revokes it. A bridge gets one per camera in `GET /v1/bridge/config`.

## Flow

1. `POST {whip_url}` with `Content-Type: application/sdp`,
   `Authorization: Bearer <bearer>` and a complete offer (non-trickle).
   `whip_url` is `{media_public_url}/whip/{source_id}`; the ingress accepts a
   POST on `/whip` and on any path below it.
2. The offer is judged first (codecs below). Then the bearer is verified
   against the media plane's key ring and issuer. Its signature is what makes
   `authorize_url` trustworthy: a token cannot point the ingress anywhere its
   minter did not choose.
3. The ingress POSTs `{ room, jti, remote_address? }` to `authorize_url` with
   the same bearer. Holding the bearer is the credential; no service secret is
   involved. The API checks revocation, the source, pause, allowances and the
   active-camera limit, ensures the camera's room and feed, and answers
   `{ token, mediaUrl?, max_resolution? }` with a 10-minute join token
   (`identity: {source_id}:whip`, `kind: "ingress"`, `transport: "webrtc"`).
   401/403 refuse the bearer; 409/429 refuse the publish for now.
4. The ingress joins the room with that token and answers `201` with the SDP
   answer and `Location: /whip/{session}`, an unguessable session id.
5. `DELETE {Location}` with the same bearer ends the session (the publisher
   leaves; its producers close). Without the right bearer it is a 404.

## Rules

- **Codecs:** video must offer H.264 with `packetization-mode=1` (Constrained
  Baseline or Main families). Audio is Opus 48000/2 and is accepted only when
  the join token may publish audio; otherwise its section is rejected in the
  answer (port 0) and the publisher sends video alone. No H.264 → 415.
- **Newest replaces old:** a WHIP publish ends an older session of the same
  identity (a browser page gets `roomClosed: "replaced"`). One live publisher
  per camera.
- **Resolution:** the source's `max_resolution`. The egress reads the first init
  segment; above it nothing is stored and the API removes the publisher with
  `resolution_not_in_plan`.
- **No trickle, no ICE restart:** `PATCH` is 405. The media plane lists all
  its candidates in the answer; a publisher that loses connectivity POSTs
  again.
- **Token in the URL:** clients that cannot set `Authorization` may pass
  `?access_token=` (RFC 6750 §2.3). Prefer the header.
- **Limits:** a media plane may refuse with 429 `too_many_attempts` (per
  client address) or 503 `capacity`, and 413 for an offer over 64 KiB.

## Errors

The body is `{ "error": "<code>" }`: 400 `bad_offer`, 401 `unauthorized`
(also 403 from the owner), 404 `not_found` / `no_such_session`, 405, 409 and
429 `refused` (from the owner; 429 `too_many_attempts` from the ingress), 413
`offer_too_large`, 415 `unsupported_codec` /
`content_type_must_be_application_sdp`, 502 when the authorize endpoint or
the media plane failed, 503 `capacity` or the authorize endpoint unreachable.
