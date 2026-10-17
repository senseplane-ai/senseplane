# 52. A sticky, load-aware brain balancer in the API

Date: 2026-10-17 · Status: accepted

## Context

Every brain subscribed to every camera's frames (NATS `frames.*.*` without a
queue group), so a second brain doubled the work instead of halving it, and
alerts would have been posted twice. A camera's analysis is stateful (tracker,
episodes, watch state machines), so a camera must stay on one brain, and a
brain that dies must not leave its cameras unwatched for long. Every
deployment must run the same code.

## Decision

The API assigns each camera to one brain, in Valkey (`spec/brain/valkey.json`,
`balancer`):

- Every brain heartbeats `sp:brain:{id}` with its load (cameras, CPU) every
  2 s with a 6 s expiry.
- When a camera's frames arrive and it has no live brain, the API assigns it to
  the least busy live brain (fewest cameras, then lowest CPU) with a
  compare-and-set, so concurrent API instances agree. A new brain has no
  cameras, so it takes new cameras first. Frames for the camera go only to
  `sp:frames:{that brain}`.
- The assignment is released when the camera goes offline. A dead brain's
  heartbeat expires within 6 s and its cameras are reassigned on their next
  frame, so a handover takes well under 10 s.
- A gentle rebalance moves one camera every 30 s from the busiest brain while
  it has at least 2 cameras more than the least busy one.
- On takeover the new brain re-reads the camera's zones and watches.
- Alert de-duplication is shared: watch cooldowns, "already announced in this
  episode", object and sound cooldowns are `SET NX` markers with expiries in
  Valkey, so a handover never posts an alert twice.

## Consequences

- Brains scale horizontally; one brain needs no configuration.
- A handover loses up to a few seconds of analysis and restarts the tracker
  and any `min_duration` timer on the new brain; the markers keep alerts from
  repeating.
- The API, not the brain, owns the mapping, because the API is where frames
  enter. The brain needs only `VALKEY_URL` and an id (`BRAIN_ID`, default the
  hostname and pid).
