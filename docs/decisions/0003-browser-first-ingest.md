# 3. Browser-first ingest; WHIP, RTMP and the bridge later

Date: 2026-10-15 · Status: accepted · Later ingest: WHIP (ADR 0034) and the bridge (ADR 0045)

## Decision
Until the core (recording, perception, watches, MCP, grants) is proven, the
only public ingest is a **browser capture page** on a phone or laptop, using
WebRTC through `mediasoup-client` with a per-source token. WHIP and RTMP come
next, then the bridge and Home Assistant, then SRT (docs/roadmap.md).

Two internal-only inputs support testing: a file-replay publisher for H.264
fixtures, and `POST /v1/sources/{id}/readings` for sensor values.

## Consequences
Until the bridge exists, sources are phones and laptops, which are not
reliable always-on cameras. The early milestones prove the architecture, not
daily usefulness.
