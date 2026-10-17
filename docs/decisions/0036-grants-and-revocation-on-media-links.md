# 36. Grants and revocation on media links

Date: 2026-10-17 · Status: accepted

## Context
Media links (HLS playback, clips, snapshots) are bearer URLs so players can
fetch them without headers. They were signed for 15 minutes and checked only
for their own scope, so a revoked key or grant kept working until expiry, the
"latest snapshot" link stayed a live view for 15 minutes, and some reads
(`GET /v1/clips/:id`, `/history`, event media) didn't check the sense or the
grant's time window.

## Decision
- **Claims in every link issued to a key:** the sealed hash of the requesting
  API key (`kr`, AES-256-GCM, never the key), the source and time range
  (`sid`, `f`, `t`), and `na` when the caller has no audio grant.
- **Re-checked on every media request** (30 s cache): the key must still exist,
  its agent must still have a video grant covering the link's source and
  range, and audio is removed when the agent has no audio grant (ADR 0037).
  Revoking a key, an agent or a grant reaches media within the cache window.
- **"Latest snapshot" links live 60 s.** Presigned object URLs live 60 s (long
  enough to follow the redirect).
- **Reads check sense and window:** clips (list and get) need a video grant
  covering the whole clip; event snapshot and clip links are omitted when the
  caller has no video grant at that time (audio-only agents see sound events
  without video); `/history` returns only granted senses inside each grant's
  window; event feedback is limited to visible events.

## Consequences
Media requests cost one cached key lookup. Links issued before this change have
no claims and keep the old behaviour until they expire (at most 15 minutes).
