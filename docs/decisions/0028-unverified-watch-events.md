# 28. Watch events say whether a model confirmed them

Date: 2026-10-17 · Status: accepted

## Context
A compiled watch has a cheap trigger and, usually, a vision-model check. On an
instance with no model configured the check is skipped and the watch fires on
its trigger alone. The summary said so in words, but agents had no field to
act on.

## Decision
Events gain `verified` (boolean or null):
- `true`: a vision model confirmed the watch;
- `false`: the watch has a check, but no model ran, so it fired on the trigger
  alone;
- `null`: the event has no model check (detections, sounds, sensor events, and
  watches compiled without a check).

The brain sends it on `brain.event`; the API stores it (events.verified) and
returns it on every event, webhook and MCP result. The API ignores the field on
anything but `watch.triggered`.

## Consequences
Agents can treat unverified events with more caution, for example ask a person
before acting.
