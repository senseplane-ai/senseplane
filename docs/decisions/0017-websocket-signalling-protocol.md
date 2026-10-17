# 17. WebSocket signalling, wire-compatible with the existing media protocol

Date: 2026-10-16 · Status: accepted · Supersedes the HTTP `/signal/*`
calls from M1 (ADR 0002 is otherwise unchanged) · Amended by ADR 0049

## Context
M1 shipped a small JSON-over-HTTP signalling API. An existing multi-node
mediasoup media plane speaks a
JSON-over-WebSocket protocol with request/response correlation, server-pushed
events and Ed25519 join tokens. Two protocols would mean two capture pages and
a protocol change before live view or more participants. (Live view later
used exactly this protocol with new methods only, ADR 0042.)

## Decision
- The open-source media plane speaks that protocol, v1, over one WebSocket per
  participant: same frame envelope, same method and event names, same error
  codes and close codes, same join-token format (EdDSA JWT, `kid`, strict
  claim set, 900 s ceiling).
- Only the subset the open-source edition needs is implemented: `join`,
  `createTransport` (send), `connectTransport`, `produce`, `closeProducer`,
  `leave`, and the events `joined`, `producerClosed`, `recordingChanged`,
  `draining`, `roomClosed`. Other methods reply `bad_request` and can be added
  later without changing the envelope.
- The implementation is new code. The reference implementation (AGPL) was read
  only to learn the wire format.
- Senseplane mapping: `room = {account_id}/{source_id}`, `identity =
  {source_id}:capture`, `kind = human`, `transport = webrtc`, audio allowed
  only if `grants.publishKinds` includes `audio`.
- Join tokens live at most 15 minutes, so a 24 h **capture ticket** goes in
  the capture link and is exchanged at `POST /v1/capture/join` for a fresh join
  token on every connect. This endpoint is a public API addition.

Spec: `spec/media/signalling.md`, `spec/media/signalling.json`.

## Same identity twice
Newest connection replaces the old one (LiveKit does the same). The replaced connection gets `roomClosed` with reason `replaced`
and must not auto-reconnect, so two pages can't evict each other in a loop.

## Post-v1 improvement
After a network change (Wi-Fi to mobile data), resume the existing session
with an **ICE restart** before falling back to a full rejoin, so the recording
continues without a recorder restart and a discontinuity.
