# API guide

The Senseplane API is a REST API under `/v1`, described by
[`spec/openapi.yaml`](../../spec/openapi.yaml), the single source of truth.
The full endpoint reference, with a sample request and response for every
endpoint, is generated from it: run `pnpm docs:build` and open
`docs/site/api.html`. This page covers what the reference can't show well:
how to authenticate, page, handle errors and receive events.

**Base URL:** `http://localhost:58080/v1` with the bundled compose setup
(port 8080 inside the container). Change the host and port for your
deployment.

## Authentication

Send an API key as a bearer token on every request:

```sh
curl http://localhost:58080/v1/sources -H "Authorization: Bearer sk_…"
```

- **Account keys** (from `create-account`) can do everything in the account.
- **Agent keys** (`POST /v1/agents`, or **Agents → For developers** in the
  console) see only what their [grants](#agents-and-grants) allow. Give these
  to your scripts and agents. MCP clients connected through the consent page
  get an agent of their own and never need a key (ADR 0048).
- **Console sessions** (from signing in at `/auth`) are keys that expire and
  belong to a person. They act with that person's role in the workspace:
  viewer, member, admin or owner (ADR 0044). A role that's too low gets
  `403 forbidden_role`. `GET /v1/me` says who is signed in, their role and
  their workspaces; `POST /v1/me/switch` moves the session to another one.
- Revoking a key or agent takes effect on the next request.
- A missing or invalid key returns `401 unauthorized`.

Keys are shown once, when they're created. Senseplane stores only a hash.

## IDs, times and formats

- IDs carry a type prefix: `src_` (source), `wat_` (watch), `evt_` (event),
  `clp_` (clip), `agt_` (agent), `grt_` (grant), `whk_` (webhook).
- Times are RFC 3339 with an offset, for example `2026-10-14T21:02:11+02:00`.
  Time ranges are `from` and `to`.
- Request and response bodies are JSON. Most endpoints reject unknown fields
  with `validation_failed`.
- Enumerations such as `Sense` (`video`, `audio`, `temperature`, `humidity`)
  are **open**: new values can appear, so handle values you don't recognise.
- Every response carries an `x-request-id` header. Quote it when reporting a
  problem.

## Pagination

List endpoints (`GET /v1/sources`, `/watches`, `/events`, `/clips`, `/audit`,
`/webhooks/{id}/deliveries`, …) are cursor-paged:

```sh
curl "http://localhost:58080/v1/events?limit=50" -H "Authorization: Bearer sk_…"
# {"data":[…], "next_cursor":"…"}
curl "http://localhost:58080/v1/events?limit=50&cursor=…" -H "Authorization: Bearer sk_…"
```

- `limit` is 1–100 (default 20).
- Keep passing `next_cursor` back as `cursor` until it's `null`.
- Cursors are opaque; don't build them yourself.

The TypeScript SDK turns lists into async iterators:

```ts
for await (const event of sp.events.list({ source: "src_…" })) console.log(event.summary);
```

## Errors

Errors share one shape:

```json
{ "error": { "code": "forbidden_sense", "message": "this agent is not granted audio on src_…", "request_id": "…", "details": {} } }
```

Switch on `code`, not on `message` (messages can change).

| Code | HTTP | Meaning |
|---|---|---|
| `validation_failed` | 400 | The request body or query is invalid. `message` says which field. |
| `unauthorized` | 401 | Missing, invalid or revoked API key. |
| `forbidden` | 403 | The key can't use this resource (for example an agent without a grant on that source). |
| `forbidden_sense` | 403 | The agent has the source but not this sense (for example `listen` with a video-only grant). |
| `not_found` | 404 | No such resource in this account (resources in other accounts also return 404). |
| `source_limit_reached` | 409 | The account is at its limit of registered or streaming sources. |
| `conflict` | 409 | The resource isn't in a state that allows this (for example live view of a source that isn't streaming). |
| `feature_not_available` | 403 | This deployment doesn't offer the feature to this account (for example live view). |
| `limit_reached` | 429 | A limit from this deployment was reached; `details.limit` names it (`max_live_viewers`, `live_view_minutes`). |
| `quota_exceeded` | 403 or 429 | An account limit was reached: `403` for a setting above the allowed maximum (such as `retention_days`), `429` when the recording allowance for the period is used up. |
| `allowance_exhausted` | 429 | The account's AI checks for the period are used up (a limit set by the deployment's quota provider). |
| `rate_limited` | 429 | Too many requests (see [Rate limits](#rate-limits)). |
| `idempotency_key_reused` | 422 | The `Idempotency-Key` was already used for a different request. |
| `forbidden_role` | 403 | The signed-in person's role is too low for this. |
| `signup_refused` | 403 | Sign-up is closed on this instance. |
| `invite_invalid` | 404 or 410 | The invite link doesn't exist, was used, revoked or expired. |
| `service_unavailable` | 503 | A dependency (such as the brain or the vision model) didn't answer. Retry later. |
| `not_implemented` | 501 | The endpoint isn't available yet. |

The capture page and media signalling use three more codes:

- **`unsupported_codec`:** the camera doesn't send H.264;
- **`resolution_not_in_plan`:** the stream is larger than the source's `max_resolution` (720p by default);
- **`needs_zone`:** a watch mentions a place the camera has no zone for. The watch is saved with status `needs_zone` and runs on the whole frame until you draw the zone.

## Rate limits

- **Requests:** 600 a minute per API key (or per client IP without one),
  30 a minute per key for the expensive routes (watch create and change,
  `ask`, memory search, conversation messages) and 600 a minute per IP for
  unauthenticated routes. Set with `RATE_LIMIT_PER_MINUTE`,
  `RATE_LIMIT_EXPENSIVE_PER_MINUTE` and `RATE_LIMIT_ANONYMOUS_PER_MINUTE`
  (ADR 0040). Over the limit: `429 rate_limited` with `Retry-After`.
- **AI checks:** a deployment can set an AI-check allowance through its quota
  provider; once it is used up, `POST /v1/sources/{id}/ask`, `POST
  /v1/watches`, `POST /v1/watches/test` and `POST
  /v1/conversations/{id}/messages` return `429 allowance_exhausted`.
  Self-hosted, there is no allowance unless you add one.
- **Demo sessions** (`POST /v1/demo/sessions`): 5 per client IP per day by
  default (`DEMO_SESSIONS_PER_IP_DAY`), returning `429 rate_limited`.

On `429`, back off and retry later. Don't retry `400`, `401`, `403` or `404`
unchanged.

## Retries and idempotency

`POST /v1/sources`, `/watches`, `/clips`, `/webhooks` and `/grants` accept an
optional `Idempotency-Key` header (1–255 characters, ADR 0030). The first
response is kept for 24 hours: a retry with the same key and body gets it
back with `Idempotent-Replayed: true`, and the same key with a different body
gets `422 idempotency_key_reused`. The SDK's create calls take
`{ idempotencyKey }`.

- Other `POST`s can create a duplicate when retried after a timeout. After a
  network error, list the resource before retrying.
- `DELETE` and `PATCH` are safe to retry.

## Sources and senses

A **source** is one camera, phone or sensor. Its `senses` say what it can
provide: `video`, `audio`, `temperature`, `humidity`.

- `POST /v1/sources` with `type: "browser"` returns `ingest.capture_url`, a
  link valid for 24 hours that turns a phone or laptop browser into the
  camera.
- `type: "whip"` returns `ingest.whip_url` and a bearer `token` for OBS and
  other WHIP encoders.
- `type: "rtsp"` (an IP camera) returns `ingest.bridge_token` and a
  `docker_command` that starts the bridge; one bridge carries several cameras
  (`bridge_id`). Its `status` can be `reconnecting`, with `status_detail` and
  `status_since`.
- `type: "sensor"` returns `ingest.integration_token` (`sit_…`). Push readings
  with it (or an account key) to `POST /v1/sources/{id}/readings`; the token
  can't do anything else.
- Tokens are shown once; `POST /v1/sources/{id}/ingest-token` rotates them and
  `DELETE` revokes them.
- `POST /v1/sources/{id}/pause` stops a camera recording and being analysed
  (`status: paused`): its live session ends and new pushes are refused with
  `409 conflict` until `POST /v1/sources/{id}/resume`. Every source has
  `status_since`, when `status` last changed.
- `GET /v1/sources/{id}/now` returns the latest snapshot (as a signed URL) or
  sensor values; `POST /v1/sources/{id}/ask` asks the vision model a question
  about the current scene.
- Privacy masks (`PATCH /v1/sources/{id}`, `privacy_masks`) are polygons in
  0–1 coordinates. They're blacked out in every snapshot and before any model
  sees a frame. Recordings stay as they were received.

## Watches

A watch is one plain-language sentence (`POST /v1/watches`). Senseplane
compiles it into a cheap trigger plus an optional vision-model check, and
returns the compiled form so you can read and edit it
(`PATCH /v1/watches/{id}`). See the [watch spec](../watch-spec.md) for trigger
types (`objects`, `motion`, `sound`, `sensor`, `schedule`, `sequence`,
`condition`, `digest`) and examples. `duration_minutes` stops a watch
automatically. `mode: "track"` makes a watch that only records when its
condition holds, to answer questions later, and sends no notifications.
Packs (`GET /v1/watch-packs`, `POST /v1/watch-packs/{id}/apply`) add a set of
watches for a use case in one step.

A watch can cover several cameras (`sources` takes ids or names), run only at
set times (`active_hours: {days, from, to, time_zone}`, overnight ranges such
as 18:00–06:00 work) and send its events only where you say
(`notify: [{type: "webhook", id}, {type: "agent", id}]`; without it, every
webhook subscribed to `watch.triggered` gets them). Before saving one, try it on
recorded history:

```sh
curl -s http://localhost:58080/v1/watches/test -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"instruction":"Tell me if a package is left at the front door","sources":["Front door"],
       "from":"2026-10-16T09:00:00Z","to":"2026-10-16T10:00:00Z","max_checks":10}'
# {"matches":[{"source_name":"Front door","at":"…","summary":"…","snapshot_url":"…"}],"checks_used":3,…}
```

An agent reads events sent to it with `GET /v1/inbox?unseen=true` and marks
them read with `POST /v1/inbox/seen` (MCP `what_happened` does both).

## Activities and questions

Activities are one thing, in one place, from a start to an end: presence of
a person, vehicle, animal or object (in each zone), sounds, and a watch's
condition while it held ([Asking about time](../activity.md)).
`POST /v1/activity/query` answers count, duration, first and last, how long
since, absence, order, per-hour, per-camera and per-site questions, and
compares them with what is usual:

```sh
curl -s http://localhost:58080/v1/activity/query -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"measure":"total_duration","what":{"label":"person","zone":"bed"},"period":"last_24_hours",
       "between":{"from":"21:00","to":"09:00"},"time_zone":"Europe/London","compare":"last_14_days"}'
# {"value":27900,"unit":"seconds","baseline":{"mean":28800,"ratio":0.97,…},"trend":{…},
#  "coverage":{"recorded":1,"complete":true,"gaps":[]},"evidence":[…],"notes":[]}
```

`GET /v1/activities` lists them, newest first (`source`, `kind`, `label`,
`zone`, `from`, `to`). `POST /v1/activity/check` runs a watch's model check
over recorded footage for something nothing tracked at the time; with a
`watch_id`, what it finds is kept as that watch's activities.

## Events

Everything Senseplane notices becomes an **event**. All senses share one
shape:

```json
{
  "id": "evt_01JA…",
  "type": "watch.triggered",
  "watch_id": "wat_01JA…",
  "source": { "id": "src_01JA…", "sense": "video", "location": "Front door" },
  "occurred_at": "2026-10-14T21:02:11+02:00",
  "ended_at": "2026-10-14T21:03:40+02:00",
  "summary": "A courier left a brown box on the doormat.",
  "labels": ["person", "package"],
  "zones": ["front_door"],
  "confidence": 0.91,
  "value": null,
  "media": {
    "snapshot_url": "https://…",
    "clip_url": "https://…"
  }
}
```

- **Types:** `watch.triggered`, `detection.<label>` for every
  [detector label](labels.md) (`detection.person`, `detection.vehicle`,
  `detection.animal`, and everyday objects such as `detection.cup`,
  `detection.laptop`, `detection.backpack`), `sound.detected`, `sensor.threshold`, `reading.threshold`
  (a sensor watch held its condition), `source.online`,
  `source.offline`, `source.view_changed` (the camera's view no longer
  matches its privacy masks). Treat unknown types as ignorable.
- **`value`** is set for sensor events, for example
  `{"sense":"temperature","value":29.4,"unit":"°C"}`.
- **`media` URLs are signed and expire after 15 minutes.** Fetch the event
  again (`GET /v1/events/{id}`) for fresh ones.
- **Feedback:** `POST /v1/events/{id}/feedback` with `relevant` or
  `not_relevant` tunes that watch.
- **Search:** `GET /v1/memory/search?q=when did the courier come?` searches
  events by meaning.

## Conversations (Ask)

Ask about your sources in plain language and get an answer that cites the
moments it is based on ([ADR 0041](../decisions/0041-conversations-and-ask.md)).

```sh
# 1. Start a conversation (the title is optional; the first question becomes it)
curl -s -X POST http://localhost:58080/v1/conversations -H "Authorization: Bearer sk_…"

# 2. Ask, and stream the answer
curl -N -X POST http://localhost:58080/v1/conversations/cnv_…/messages \
  -H "Authorization: Bearer sk_…" -H "accept: text/event-stream" -H "content-type: application/json" \
  -d '{"content":"When did someone come to the door?"}'
```

- **Body:** `content` (required), `sources` (default every source the key can
  see), `from` / `to` (the history to search; default the last 7 days),
  `time_zone` (IANA name the answer uses for times; default UTC).
- **Streamed** (`Accept: text/event-stream`): `status` `{text}` while it works
  ("Searching Front door, Reception…", "Looking at Front door…"), `delta`
  `{text}` as the answer is written, `moment` (a Moment) the first time one is
  cited, `suggested_watch` `{instruction, sources}`, then `done` `{message}`,
  or `error` with the usual error body. Errors before the answer starts (not
  found, limits) come back as a normal JSON error response.
- **Not streamed:** the response is the assistant message.
- **Messages** (`GET /v1/conversations/{id}`) have `content`, `moments` and an
  optional `suggested_watch`. The content cites moments as `[1]`, `[2]`, … in
  the order of `moments`. A moment has `source_id`, `source_name`, `at`,
  `label`, a masked `snapshot_url` (null for sounds) and usually a `clip_url`;
  links are signed fresh on every read and expire after 15 minutes.
- **Grounded:** answers only cite what the history search, event list or a
  live look returned. If nothing matches, the answer says so. A suggested
  watch is only a suggestion: send it to `POST /v1/watches` to turn it on.
- **Grants:** an agent key sees only its own conversations, and answers use
  only the sources and senses it is granted (a live look needs a video grant).
- **AI checks:** every model call made for an answer counts as an AI check
  (`ai_checks_by_kind.chat` in `GET /v1/usage`), usually two to four per
  answer. Answers share the expensive-route rate limit with `ask` and
  memory search. Without a model configured, the answer lists the closest
  moments from history instead.
- **Feedback:** `POST /v1/conversations/{id}/messages/{mid}/feedback` with
  `{"value": "helpful"}` or `"not_helpful"` (`null` clears it) marks an
  answer; assistant messages carry `feedback`.
- **Times** in answers use the request's `time_zone` (IANA), else the
  workspace's, else UTC.
- `GET /v1/conversations` lists conversations, most recently active first;
  `DELETE /v1/conversations/{id}` deletes one with its messages and the
  snapshots of its live looks.
- The TypeScript SDK has `sp.conversations.create/list/get/delete`,
  `send(id, {content})` for the whole answer, and `stream(id, {content})`,
  an async iterator of the events above.

## Webhooks

Subscribe with `POST /v1/webhooks`:

```json
{ "url": "https://example.com/hooks/senseplane", "events": ["watch.triggered", "sensor.threshold"] }
```

`events` lists event types. `"*"` subscribes to everything, and a prefix
wildcard such as `"detection.*"` to every type under it (all detections,
everyday objects included). The same patterns work in `GET /v1/events?type=`.

The response includes a `secret` (`whsec_…`). **It's shown only once**; store
it to verify deliveries.

Each delivery is a `POST` of one event as JSON, with these headers:

| Header | Value |
|---|---|
| `Senseplane-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the webhook secret>` |
| `Senseplane-Event` | the event type |
| `Senseplane-Delivery` | the delivery id (use it to drop duplicates) |
| `User-Agent` | `Senseplane-Webhooks/1` |

- **Respond with any 2xx within 10 seconds.** Anything else (or a timeout)
  is retried with backoff (5 s, 15 s, 30 s, 1 min, 2 min, 5 min, 10 min,
  30 min, 1 h, 2 h, then every 4 h) for up to 24 hours. A delivery can arrive
  more than once, so make your handler idempotent on `Senseplane-Delivery`.
- Redirects aren't followed.
- See every attempt with `GET /v1/webhooks/{id}/deliveries`, and resend one
  with `POST /v1/webhooks/{id}/deliveries/{deliveryId}/redeliver`.
- Outside development, webhook URLs must be public `https` addresses.

### Verifying signatures

Always verify against the **raw request body**, before parsing JSON, and
reject timestamps more than 5 minutes old.

**TypeScript** (with the SDK):

```ts
import { verifyWebhook } from "senseplane";

// Express example: use express.raw({ type: "application/json" }) for this route.
app.post("/hooks/senseplane", (req, res) => {
  try {
    const event = verifyWebhook(req.body, req.headers["senseplane-signature"], process.env.SENSEPLANE_WEBHOOK_SECRET!);
    console.log(event.type, event.summary);
    res.sendStatus(204);
  } catch {
    res.sendStatus(400);
  }
});
```

**Python** (standard library only):

```python
import hashlib, hmac, json, time

def verify_webhook(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> dict:
    parts = dict(p.split("=", 1) for p in header.split(","))
    timestamp, signature = int(parts["t"]), parts["v1"]
    if abs(time.time() - timestamp) > tolerance:
        raise ValueError("timestamp outside tolerance")
    signed = f"{timestamp}.".encode() + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise ValueError("signature mismatch")
    return json.loads(raw_body)

# Flask: event = verify_webhook(request.get_data(), request.headers["Senseplane-Signature"], SECRET)
```

## Agents and grants

Give each agent its own key, and grant only what it needs:

```sh
# 1. Create an agent; its key is in the response (shown once)
curl -s -X POST http://localhost:58080/v1/agents -H "Authorization: Bearer sk_…" \
  -H "content-type: application/json" -d '{"name":"Home assistant agent"}'

# 2. Grant it video from one camera
curl -s -X POST http://localhost:58080/v1/grants -H "Authorization: Bearer sk_…" \
  -H "content-type: application/json" \
  -d '{"agent_id":"agt_…","source_ids":["src_…"],"senses":["video"]}'
```

- Grants are per agent, per source and per sense, with an optional time
  window (`"window": {"from": "…", "to": "…"}`). An agent with a video-only grant gets `403 forbidden_sense` on
  `listen`.
- `abilities` (default both) says what else the agent may do on those
  sources: `watch` lets it create, change and stop watches (without it,
  `403 forbidden`); `history` lets it read recorded data older than the last
  two hours (events, memory search, playback, timeline, clips and
  conversations). Live access (snapshots, ask, live view, listening, sensor
  readings and their last-hour trend) comes with the senses.
- Agents have a `kind`: `key` (made here) or `app` (an MCP client someone
  approved on the consent page, with `client_name`, `redirect_host` and
  `connected_at`). Both show `last_active_at`. `POST /v1/agents/connect` is the
  consent page's call and returns a single-use code for the MCP service, never
  a key.
- `DELETE /v1/agents/{id}` revokes the agent, its keys and its grants on the
  next request.
- `GET /v1/audit` lists every look, listen, playback, search and grant change:
  who, what, when.

## Playback and clips

- `GET /v1/sources/{id}/playback?from=…&to=…` returns a signed HLS URL for any
  range within the source's retention, up to 24 hours per playlist. Play it
  with any HLS player (Safari natively, `hls.js` elsewhere).
- `GET /v1/sources/{id}/timeline` lists recorded ranges and gaps.
- `POST /v1/clips` saves a range (up to 1 hour) as a clip. Clips are kept
  until you delete them, even after the raw footage expires.

## Live view

- `POST /v1/sources/{id}/live` (`{"audio": true}` optional) returns a
  single-use media token, the signalling URL and the idle timeout. In a
  browser, `openLive` in `console/src/live/client.ts` does the rest: it
  joins the [media signalling protocol](../../spec/media/signalling.md) as a
  viewer and plays the camera's own H.264 (no transcoding) in a `<video>`.
- Needs a video grant; audio needs an audio grant too, `audio: true`, and a
  source that records audio. Privacy masks apply to analysis, snapshots and
  model inputs, not to live view or recordings.
- Viewers with no activity for `idle_timeout_seconds` (default 10 minutes)
  are closed. Each start is in the audit log (`live.start`), and viewing
  time is in `GET /v1/usage` as `live_view_minutes` (per source and day);
  `live_viewers_now` is how many people are watching right now.
- A deployment can turn it off (`403 feature_not_available`), cap people
  watching at once or set an allowance (`429 limit_reached`); `GET
  /v1/account` shows the account's `limits`. Self-hosted, it's on and
  unlimited.

## Retention, usage and your data

- Raw footage is kept for the account's `retention_days` (default 7), which a
  source can override (`PATCH /v1/account`, `PATCH /v1/sources/{id}`). Clips
  and events are kept until deleted.
- `GET /v1/usage` reports camera-minutes (by source and resolution), storage,
  AI checks by kind, live view minutes, and source counts against limits.
- `POST /v1/account/export` starts a full export (JSON plus signed media
  links). `DELETE /v1/account` deletes the account and all its data within
  24 hours.

## More references

- [MCP tools](mcp-tools.md): the 8 tools agents use.
- [Media signalling protocol](../../spec/media/signalling.md): how capture
  clients publish to the media plane, and live viewers consume from it.
- Media control API: `docs/site/media-control.html` after `pnpm docs:build`.
- [Watch spec](../watch-spec.md) and [architecture](../architecture.md).
