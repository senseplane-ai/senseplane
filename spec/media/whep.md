# Push-to-talk to a box (WHEP)

A camera behind a box has its speaker on the home network, and the box only
makes outbound connections. To hear a person's push-to-talk, the box pulls
the room's `talkback` track from the media plane with a WHEP-style request
(the shape of WHEP, draft-ietf-wish-whep: an SDP offer POSTed, an answer
back, `DELETE` to end), on its own outbound connection (ADR 0074).

## The bearer

An ordinary join token (`tokens.md`, `aud: "media"`), single use, that the
API hands the box with the `talk` command:

- `identity`: `{source_id}:speaker`, the listener the talker's token names in
  `visibleTo` (`signalling.md`, *Talk-back*). A talker whose token names the
  phone (`{source_id}:capture`) can't be heard this way.
- `kind: "agent"`, `transport: "webrtc"`.
- `grants`: `canPublish: false`, `canSubscribe: true`, `canPublishData: false`,
  `subscribeKinds: ["audio"]`, `maxSubscriptions: 1`.
- `exp`: the most this one press may last; the session ends then.

## Flow

1. `POST {media_public_url}/whep/talkback` with
   `Content-Type: application/sdp`, `Authorization: Bearer <join token>` and
   a complete offer (non-trickle) with one audio section that receives Opus
   48000/2.
2. The node admits the token like any join (signature, issuer, single use,
   the join gate). It answers 404 `no_talkback` when the room has no
   `talkback` track, or the track's `visibleTo` doesn't name this identity:
   the same answer, so nothing is disclosed. A token that may publish, or
   may not receive audio: 403. No Opus in the offer: 415.
3. It consumes the track for the listener and answers `201` with an ICE-lite
   SDP answer (the audio section `sendonly`, the track's SSRC) and
   `Location: /whep/talkback/{session}`. Audio flows once DTLS is up; the
   talker then gets `talkbackListening`.
4. The session ends when the talker's track closes (the button released, the
   talker gone or removed), when the token's `exp` passes, when the room
   ends, or on `DELETE {Location}` with the same bearer. The node closes the
   transport, which the box sees as the connection closing.
5. A listener that goes first (DELETE, DTLS closed, ICE lost, `exp`) ends the
   talker's track too, and the talker gets `talkbackEnded` with `reason`
   `listener_left` or `expired`.

`PATCH` (trickle ICE) answers 405.
