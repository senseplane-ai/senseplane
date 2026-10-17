# Media signalling protocol (v1)

Part of the media contract (ADR 0002, 0017, 0049). One WebSocket per
participant; the open-source media server and any other media plane speak it
identically. Written from the wire format; no code was copied. Message
schemas: [`signalling.json`](signalling.json). Token claims: [`tokens.md`](tokens.md).

## Transport

- The client opens the room's `signal_url` (from `POST /control/rooms`;
  Senseplane passes it on as `url` / `media_url`), `ws://` or `wss://`. Text
  frames, one JSON object each, 512 KiB maximum.
- The node pings every 30 s and drops a socket that missed a pong.
- The join token travels in the first frame, **never in the URL**. A socket
  that sends no `join` within a few seconds is closed with 1008 `unauthorized`.

## Frames

| Kind | Shape | Rule |
|---|---|---|
| Request | `{ "method": "...", "id": <int ≥ 0>, ...params }` | Exactly one reply with the same `id` |
| Reply | `{ "id", "ok": true, "data": {...} }` or `{ "id", "ok": false, "code", "message"? }` | `code` is from the closed list below |
| Event | `{ "event": "...", ...fields }` | No `id`; never replied to |

Clients ignore unknown events and unknown fields (additive changes stay on
v1). Request objects are not strict: a node ignores fields it does not know
(`traceparent`, `timings`).

## Requests

| Method | Params | `data` on success |
|---|---|---|
| `join` | `protocolVersion: 1`, `token` | `{ participantId }`, followed by a `joined` event |
| `createTransport` | `direction: "send" \| "recv"`, `sctp?`, `network?` | WebRTC: `{ transportId, iceParameters, iceCandidates, dtlsParameters, sctpParameters?, direction }`. Plain: `{ transportId, ip, port, rtcpPort?, srtpParameters?, direction }` |
| `connectTransport` | `transportId`, then `dtlsParameters` (WebRTC) or `ip`, `port`, `rtcpPort?`, `srtpParameters?` (plain) | `{ connected: true }` |
| `produce` | `transportId`, `kind`, `rtpParameters`, `appData?` (`appData.source`: `camera`, `microphone`, …) | `{ producerId }` |
| `closeProducer` | `producerId` | `{ producerId, closed: true }` |
| `consume` | `transportId`, `producerId`, `rtpCapabilities` | `{ consumerId, producerId, kind, rtpParameters, type, paused }` |
| `resumeConsumer` | `consumerId` | `{ consumerId, resumed: true }` (a video consumer also gets a keyframe request) |
| `pauseConsumer` | `consumerId` | `{ consumerId, paused: true }` |
| `closeConsumer` | `consumerId` | `{ consumerId, closed: true }` |
| `requestKeyFrame` | `consumerId` | `{ requested: true }` |
| `leave` | — | `{ left: true }`, then the node closes with 1000 `left` |

The transport type comes from the token's `transport` claim and from nowhere
else. A plain transport's `connectTransport` names where the node sends RTP;
a node only sends to addresses on its own private network.

Older clients read the WebRTC reply's id as `id`; the open-source node sends
both `transportId` and `id`, and new clients read `transportId`.

A node may implement more methods (`pauseProducer`, `resumeProducer`,
`setPreferredLayers`, `broadcast`, `setHand`, `diagnostics`, …). One it does
not implement is a `bad_request` reply. There is no `keepAlive`: viewer
liveness is the API's (see *Live view*).

Any request before a successful `join` gets `unauthorized`. A second `join`
gets `bad_request`.

## Join

In this order, each failure a reply with the code and a 1008 close:

1. `protocolVersion` is not 1 → `protocol_version`.
2. The token does not verify (`tokens.md`) → `unauthorized`; its `jti` was
   already used → `replayed`.
3. The node is draining → `node_draining`.
4. The identity was removed by `DELETE /control/rooms/{room}/participants/{identity}`
   after the token's `iat` → `unauthorized`.
5. The room was never created → `no_such_room`; it has ended → `room_closed`.
6. The identity is already connected (below).
7. The room is full (`maxParticipants`, not counting the identity being
   replaced) → `capacity`.

Then the `join` reply and the `joined` event:
`{ event: "joined", identity, room, routerRtpCapabilities, peers, producers, iceServers, recording, grants }`.
`producers` lists only what this token may receive (identity rules and
`subscribeKinds`), each `{ producerId, identity, kind, source? }`. `grants`
echoes what the node will enforce. `recording` is true while any `egress`
participant is present.

## Same identity twice: newest replaces old

A `join` for an identity that is already connected **replaces** the older
connection, wherever it is served. The older one gets
`{ "event": "roomClosed", "reason": "replaced" }` and a 1008 `room_closed`
close; its producers close (an egress follows the new ones). A client told
`replaced` **must not reconnect on its own**: two clients that both reclaimed
the identity would take it from each other for ever. The Senseplane capture
page shows "This camera was opened on another device".

The one exception: a token with `kind: "ingress"` and `transport: "plain"`
(an RTMP-style encoder) keeps the refusal: the second join fails with
`duplicate_identity`. A WHIP publisher is `ingress` over `webrtc` and replaces.

## Events

| Event | Fields | When |
|---|---|---|
| `joined` | see *Join* | Right after the `join` reply |
| `producerAppeared` | `producerId`, `identity`, `kind`, `source?` | A producer this participant may receive was created |
| `producerClosed` | `producerId`, `consumerId?` | A producer closed (the client's own, or one it consumed) |
| `peerJoined`, `peerLeft` | `identity`, … | Optional; a node may send them |
| `recordingChanged` | `recording` | An egress joined or left |
| `draining` | `reconnectAfterMs` | The node is going away: reconnect with a fresh token after the delay |
| `roomClosed` | `reason` | The session is over; don't reconnect automatically |

`newProducer` (`producerId`, `identity`, `kind`) is the old name of
`producerAppeared`. Nodes send `producerAppeared`; clients should accept both.

`roomClosed.reason` is `replaced`, the `reason` of a participant removal
(Senseplane: `expired`, `allowance_exhausted`, `resolution_not_in_plan`,
`idle`, `source_offline`, `revoked`, `ended`, `paused`), or `room_closed` when
none was given or the whole room ended.

A capture client told `resolution_not_in_plan` sent video above its token's
`maxResolution`; nothing was stored. It should reconnect at most once with a
lower capture size, never transcode.

## Rooms and liveness

A room is created by `POST /control/rooms`. It ends after
`emptyTimeoutSeconds` (default 300) with nobody in it who keeps it alive:
`human` or `sip` participants, or, with `liveness: "any"`, anyone but an
`egress`. A room's `codecs` decide what may be produced: Senseplane's rooms
are `["h264", "opus"]` (H.264 Constrained Baseline and Main, packetization
mode 1; Opus), so a VP8 produce fails.

## Live view (ADR 0042)

A viewer joins with a subscribe-only token from `POST /v1/sources/{id}/live`
(identity `{source_id}:viewer:{session_id}`). `joined.producers` lists the
camera's producers the viewer may consume. The viewer creates a `recv`
transport, connects it, calls `consume` for each producer and
`resumeConsumer` once its track is attached, and consumes again on every
`producerAppeared`. Nothing is transcoded.

- **Audio only when allowed.** Without `audio` in `grants.subscribeKinds`, the
  audio producer is never listed in `joined` or `producerAppeared`, and
  `consume` on it fails with `forbidden`. The node enforces this.
- **Idle close, viewer counts, limits and camera-offline grace are the
  API's.** The console tells the API it is still watching
  (`POST /v1/live/{session_id}/keepalive` on user activity); the API counts
  viewers from `participant.joined`/`participant.left` room events, and ends a
  viewer by removing the participant with reason `idle`, `source_offline`,
  `allowance_exhausted`, `revoked` or `ended`. A room's `maxParticipants`
  caps viewers per camera (`capacity`).
- `produce` and a `send` transport fail with `forbidden` for a token without
  `canPublish`.

## Errors

`unauthorized`, `replayed`, `protocol_version`, `forbidden_transport`,
`forbidden`, `not_subscribable`, `subscription_limit`, `room_closed`,
`no_such_room`, `no_such_producer`, `no_such_transport`,
`duplicate_identity`, `node_draining`, `capacity`, `bad_request`, `internal`.

Join failures close the socket with **1008** and the code as the reason; an
internal failure during join closes with **1011**.

## Getting a token for the capture page

Join tokens are short-lived, so the capture link carries a **capture ticket**
instead (JWT, `aud: "senseplane-capture"`, 24 h, verified by the API only).
The page exchanges it at `POST /v1/capture/join` (`{ "ticket" }` →
`{ token, url, expires_at }`) for a fresh join token and the signalling URL,
again on every reconnect.
