# 43. Watch destinations, agent inboxes, schedules and backtests

Date: 2026-10-16 · Status: accepted

## Context
Every `watch.triggered` event went to every webhook subscribed to the type, so
an account with several integrations could not say "this watch tells the
on-call webhook and my agent, nothing else". Agents that started a watch over
MCP had no way to hear back except searching memory. Watches could not be
limited to times of day in a real time zone (the compiler's `active_hours` is
UTC, ADR 0020), and there was no way to see what a watch would have caught
before turning it on.

## Decision
**Destinations.** Watches gain `notify: Destination[]`, where a destination is
`{type: "webhook", id}` or `{type: "agent", id}` (`spec/schemas/destination.json`,
column `watches.notify`, migration 0019).
- Empty or absent (every existing watch) keeps the old routing: every webhook
  subscribed to `watch.triggered` or `*`.
- Otherwise `watch.triggered` goes only to the listed webhooks, through the
  same signed, retried, logged delivery path, whatever event types those
  webhooks subscribe to (naming one is the subscription), and to the listed
  agents' inboxes. The Events feed always has every event.
- Other event types (detections, sounds, thresholds, view changes) are not
  watch-triggered and keep subscription routing.
- Create and update check that ids belong to the account: webhooks that exist,
  agents that are not revoked (`400 validation_failed`, `details.unknown`). An
  agent key may only list itself (`403 forbidden`); it can't see the account's
  webhooks or other agents.
- A webhook deleted later, or an agent revoked later, stays in the list and is
  skipped at delivery. We don't strip it: an emptied list would silently fall
  back to "every webhook".

**Agent inboxes.** An agent is a row in `agents` (what `GET /v1/agents` lists:
agent keys, which MCP OAuth clients use). Events routed to it are queued in
`agent_inbox` (one row per agent and event, `seen_at` once read).
`GET /v1/inbox` and `POST /v1/inbox/seen` read and acknowledge it: an agent key
reads its own, an account key names the agent. Items are filtered by the
agent's current grants on every read, like every other read (ADR 0024); a watch
may route to an agent whose grants don't cover its cameras, and the agent just
doesn't see those events until it is granted.

In MCP, `what_happened` returns unread inbox events first
(`new_from_your_watches`) and marks them seen; with `source` it returns and
marks only that camera's. `watch_for` with an agent key sets `notify` to the
agent itself (opt out with `notify_me: false`), since the agent asked to be
told. Account keys keep the old routing. While a session is open, the MCP
server polls the inbox (`MCP_INBOX_POLL_SECONDS`, default 10) and sends a
logging notification (`logger: "senseplane.inbox"`) plus
`notifications/resources/updated` for `senseplane://inbox`. Over stdio that
starts after `initialized`; the remote server answers the Streamable HTTP GET
stream (it was 405) and stays stateless. Polling the public API, rather than
pushing over NATS, keeps the MCP server a plain API client, and grants and
revocation apply with no extra path; the cost is up to one poll interval of
latency, and a request per open session per interval.

**Schedules.** Watches gain `active_hours: {days?, from, to, time_zone?} | null`
(`spec/schemas/watch-schedule.json`, column `watches.active_hours`, in the
`watches` KV value). It is wall-clock time in an IANA zone (default UTC), so
it follows daylight saving: a skipped hour never matches and a repeated hour
matches twice. An overnight span (`to` before `from`) belongs to the day it
starts on, `from` equal to `to` is the whole day, and absent `days` means
every day. The brain evaluates it with `zoneinfo` (the image now installs
tzdata), the API with `Intl` for sensor watches and backtests; both share the
same rules (`watches.py` `in_span`, `schedule.ts` `inSpan`). The compiler's
UTC `active_hours` still applies too, now with the same overnight rule. Only
IANA names are accepted (no `+02:00`), because zoneinfo has no offset zones.

**Several cameras.** Watches already took `sources[]` and the brain already
kept trigger state and cooldown per (watch, camera). Now `sources` accepts
names as well as ids (case-insensitive; an ambiguous name is refused), events
carry `source.name`, and the summary of a watch on several cameras starts with
the camera name.

**Backtests.** `POST /v1/watches/test` takes an instruction (compiled first),
a compiled watch, or a `watch_id`, plus sources and a range of at most 7 days.
The brain keeps no per-frame analysis, so the cheap trigger is replayed over
what is stored: detection events (one per label per episode, with zones,
start, end and snapshot), sound events, and sensor readings. `enter` is the
episode start, `leave` its end, `present`/`stationary` with `min_duration_s`
need an episode at least that long, `motion` stands in with any detection in
the zone, `schedule` uses stored snapshots at its interval, and `sequence`
chains its steps within `within_s`. Cooldown and both schedules apply per
camera. The model check then runs on at most `max_checks` (default 10, maximum
50) candidate snapshots through a new `rpc.brain.check`, each metered as an AI
check (`ai_checks`, detail `backtest`); the route is refused like `ask` when an
account is over its AI-check limit. The reply lists `matches` with signed
snapshot links (the caller's media claims, ADR 0036), `checks_used`,
`candidates` and `unchecked`. With no vision model, candidates come back with
`verified: false`, as live events do (ADR 0028).

## Consequences
- Old watches and old clients behave exactly as before.
- The backtest is an approximation of the live trigger: counts above one,
  stationary-ness and motion aren't stored, and the check sees the arrival
  snapshot rather than the frame the live check would have seen. It answers
  "would this have caught last night's delivery?", not "exactly how many
  events would it have sent".
- An agent that never calls `what_happened` and has no open session never sees
  its inbox; items stay unread (an inbox row goes when its event or the
  account does).
- MCP notifications reach clients that keep the GET stream or stdio open; most
  chat clients display them without waking the model, which is why
  `what_happened` returns the inbox first.
