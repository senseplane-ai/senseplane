# 2. Pluggable media plane behind a contract; open source is single-node

Date: 2026-10-15 · Status: accepted · The contract's NATS events and analysis subjects are superseded by the HTTP media contract and Valkey (ADR 0049, 0050, 0051)

## Context
The media plane is deployed separately from the app. Larger deployments need
more than one media node, which brings node registry, placement and
cross-node routing that a single machine doesn't need.

## Decision
- The app knows only the **media contract** in `spec/media/`: a control API
  (create/delete ingest sessions, keyframe requests, health), Ed25519 ingest
  tokens signed by the API and verified by media, NATS events
  (`media.source.*`, `media.segment.written`, `media.recording.gap`), analysis
  subjects (`frames.*`, `audio.*`) and object-storage key layout.
- The app never imports mediasoup. The media plane has no database access.
- `media/` in this repo is **single-node**. A multi-node media plane can be
  plugged in instead if it implements the same contract and speaks the same
  browser signalling protocol, so one capture page works with either.

## Consequences
The contract is versioned like a public API. Any engine that satisfies it can
replace `media/`.
