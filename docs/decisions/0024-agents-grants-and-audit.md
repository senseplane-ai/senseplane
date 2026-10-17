# 24. Agents, grants and the audit log

Date: 2026-10-16 · Status: accepted

## Decision
- **Two kinds of key.** An account key (created with the account) has full
  access. An **agent** (`POST /v1/agents`) gets its own key, shown once, and
  sees only what its **grants** allow. Deleting an agent revokes its keys and
  grants.
- **A grant** names sources, senses and an optional time window. An agent may
  hold several; access is their union.
  - Live access (`now`, `ask`, the MCP `look`/`listen`) needs the sense
    granted and *now* inside the window.
  - Recorded data (events, memory search, playback, timeline, clips,
    history) is filtered to granted sources, senses (an event's sense: video,
    audio, temperature, humidity) and the window; a playback range outside it
    is refused.
  - Source listings show only granted sources, with `senses` cut down to the
    granted ones, so an agent with a video-only grant sees a camera without
    `audio` (and MCP `listen` refuses with `forbidden_sense`).
  - Agents can create, read and stop watches on granted sources, and save
    clips; everything else (sources, webhooks, agents, grants, account,
    audit, usage) is owner-only (`403 forbidden`).
- **Revocation is immediate.** Keys and grants are read from Postgres on every
  request (no cache), so a revoked grant or agent fails on the next request
  (target: within 60 s, measured in docs/milestones/m6.md). Signed media URLs
  already handed out stay valid until they expire (15 min).
- **Audit log.** Every authenticated `/v1` request writes an entry (actor
  `owner:<key prefix>` or `agent:<id>`, action = method + route, target = the
  id in the path, status). `GET /v1/audit` lists them; the `AuditLog` sink
  passes them on to modules too. Entries are account data (row-level
  security) and are deleted with the account.

## Consequences
- One extra query per request for agent keys (grants by agent id, indexed).
- The audit log grows with traffic and is kept until the account is deleted;
  a retention setting for it is future work.
