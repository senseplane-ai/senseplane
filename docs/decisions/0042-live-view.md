# 42. Live view

Date: 2026-10-16 · Status: accepted · Amended by ADR 0049, 0050 (viewer counts and idle close in the API) · Supersedes the earlier scope
decision that v1 has no live view (recorded playback only; roadmap "Later:
live view (WHEP)")

## Context

Watching a camera now is the first thing people expect from a camera console,
and agents with a video grant can already see a still of "now". The media
plane is a mediasoup SFU that already receives every camera as H.264 (and
Opus when audio is recorded), so forwarding that stream to a browser costs
bandwidth and a little CPU, not transcoding.

## Decision

- **Transport: the existing signalling protocol, not WHEP.** Viewers speak
  media signalling v1 (ADR 0017) with new methods only: `createTransport`
  with `direction: "recv"`, `consume`, `resumeConsumer`, `pauseConsumer`,
  `closeConsumer`, `keepAlive`, and a `newProducer` event. The envelope,
  join flow, error codes and close codes are unchanged, so a multi-node media
  plane that speaks the protocol can serve the same viewers. WHEP can be added
  later as a second egress for third-party players.
- **No transcoding.** The viewer receives the camera's own H.264 and Opus.
  Privacy masks don't apply to live view, as they don't to recordings; they
  apply to analysis frames, snapshots and model inputs.
- **Grants.** `POST /v1/sources/{id}/live` needs a video grant on the source
  (agent keys); audio is sent only when the caller asks for it (`audio: true`)
  **and** has an audio grant **and** the source records audio. Asking for
  audio without the grant is `403 forbidden_sense`. The media plane enforces
  the same rule from the token: a viewer token without audio never lists or
  consumes the audio producer.
- **Viewer tokens** are ordinary join tokens (EdDSA, same JWKS, same strict
  claim set) that are subscribe-only: `canPublish: false`, `canSubscribe:
  true`, and Senseplane extension grants `subscribeKinds`,
  `idleTimeoutSeconds` and `maxLiveViewers`. They are scoped to one source
  (`room`), one session (`jti` = the live session id, single use) and live
  60 s; the session itself lasts until it is closed.
- **Idle close.** A viewer that sends no `keepAlive` for the idle timeout
  (default 10 minutes, `LIVE_IDLE_TIMEOUT_SECONDS`) is closed with
  `roomClosed` reason `idle`. The browser helper sends `keepAlive` on user
  activity (pointer, keys, touch, scroll, the tab becoming visible), at most
  every 30 s, so a forgotten tab stops costing bandwidth. A source that stops
  streaming closes its viewers after a 30 s grace (`source_offline`) unless
  the camera comes back, in which case viewers get `newProducer` and carry on.
- **Quota hook.** The quota provider gains `liveView` (feature switch;
  `403 feature_not_available` when false), `maxLiveViewers` (people watching
  at once across the account; `429 limit_reached`) and a usage meter
  `live_view_minutes` for `usageLimits` (a hard limit refuses new viewers with
  `429 limit_reached` and ends current ones with reason
  `allowance_exhausted`; it never stops cameras). The open-source default is
  enabled and unlimited (`QUOTA_LIVE_VIEW=0` and `QUOTA_MAX_LIVE_VIEWERS`
  exist for operators). The media plane also has an operator safety cap per
  source (`MEDIA_MAX_VIEWERS_PER_SOURCE`, default 50).
- **Metering.** The media plane reports joins, leaves and per-source counts
  (`media.live.viewer.joined`, `media.live.viewer.left`, `media.live.viewers`
  every `LIVE_REPORT_SECONDS`, default 60, and on change). The API writes
  `live_view_ms` usage records per source, split at UTC midnight, from those
  ticks, so long sessions are metered while they run. `GET /v1/usage` shows
  `live_view_minutes` (one person watching one source for one minute),
  per source and per day. Sessions the media plane stops reporting (a node
  restart) are closed after three missed reports and metered up to the last
  one.
- **Audit.** Every start writes a `live.start` audit entry with the session id
  and whether audio was included, besides the usual request entry.
- **Account limits.** `GET /v1/account` gains `limits` (live view on/off,
  live view minutes, viewers at once, camera minutes, storage, AI checks) and
  `plan_label`, all from the quota provider, so a console can show a locked
  state or remaining allowance without knowing the deployment's plans.
- **Not the API's job:** session state lives in `live_sessions` (migration
  0018) only for metering, caps and audit; the media plane is the authority
  on who is connected.

## Other choices

- Keepalive is a signalling request (`keepAlive`), not an HTTP heartbeat: the
  socket is already open, and it keeps the API out of the hot path.
- `max_live_viewers` counts across the whole account (a 3×3 grid is nine
  viewers); the API counts issued-but-unjoined tokens for their 60 s too, and
  the media plane re-checks at join.
- Concurrent viewer counts reach the API through NATS, like segment events;
  the API checks the media plane's live count before issuing a token.
- The `conflict` error code (409) is new: live view of a source that isn't
  streaming.

## Consequences

- A viewer costs one recv transport and one or two consumers on the node that
  receives the camera (piped across workers when the camera reconnects on
  another one). Egress bandwidth is the main cost; the idle close and the
  quota hook bound it.
- The console's Live view page uses `console/src/live/client.ts`
  (`openLive`); `console/live-test.html` is a dev-only page for the e2e check
  (`e2e/live-check.ts`).

## Addendum (2026-10-16, integration): who is watching now

`GET /v1/usage` includes `live_viewers_now`: live sessions joined and not yet
ended across the account (from the media plane's reports). The console's live
view strip reads it as "N of M people watching now" when `max_live_viewers` is
set, else "N people watching now", refreshed every 15 s.
