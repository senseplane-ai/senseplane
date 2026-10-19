# 41. Conversations and Ask

Date: 2026-10-16 · Status: accepted · The NATS transport is superseded by ADR 0051 (Valkey); masks are applied in the API since ADR 0049

## Context
The console's home is a chat ("Ask"): a person types "when did someone come
to the door?" and gets a short answer that points at the moments it is based
on, with snapshots and clips. The pieces exist already (memory search, events,
`look`/`ask` on a live frame, watches); what was missing is something that
chooses between them, keeps the conversation's context and never makes an
event up.

## Decision
- **API.** `POST/GET /v1/conversations`, `GET/DELETE /v1/conversations/{id}`
  and `POST /v1/conversations/{id}/messages` (spec/openapi.yaml). A message
  returns as JSON, or streams as Server-Sent Events with `Accept:
  text/event-stream`: `status`, `delta`, `moment`, `suggested_watch`, then
  `done` or `error`. Validation, not-found and limit errors are ordinary JSON
  responses before the stream starts.
- **The brain runs the loop** (`brain/senseplane_brain/chat.py`): a small
  tool-using loop over the OpenAI-compatible client (ADR 0008), at most 6
  model calls per answer, streamed. Tools: `search_history` (memory search),
  `list_events`, `view_event` (an event's stored snapshot to the vision
  model), `look` (the latest frame to the vision model), `list_sources` and
  `propose_watch`. Results carry the detector's `confidence` and, from a
  search, a separate `match` (closeness to the query), so the model doesn't
  mistake one for the other. The last few turns (12 messages) go with each question.
  The chat model is `AI_MODEL_CHAT`, defaulting to `AI_MODEL_TEXT`; it must
  support tool calls.
- **Transport.** `rpc.brain.chat` is acked at once; the brain then publishes
  events to an inbox the API owns and calls history and event tools with
  requests to `<inbox>.tool` (spec/brain/subjects.json). Those tools run in
  the API, with the caller's grants (the same filter as `GET /v1/events`), so
  grants are enforced in one place and the brain never touches Postgres.
  `look` stays in the brain, which holds the frames. An idle (60 s) and a
  total (180 s) timeout end a stuck answer.
- **Sources.** The answer uses the sources in the request, or every source the
  key can see. Within those, sources named in the question (by name or
  location) are the default for searches; otherwise all of them. Statuses name
  them ("Searching Front door, Reception…", "Looking at Front door…").
- **Grounding.** Every tool result carries a ref (`m1`, `m2`, …). The model
  cites refs; the brain rewrites them as it streams to `[1]`, `[2]`, … in the
  order first cited and emits a `moment` for each, before the text that cites
  it. Refs the model invents are removed, and the API accepts a moment only
  if the caller may see that event (or may look at that camera). The prompt
  forbids stating anything the results don't say and asks for "nothing found"
  when nothing matches. A short preamble written before a tool call ("Let me
  check…") is held back and dropped.
- **Moments are stored as references** (event id, or the snapshot key of a
  live look) in `messages.moments` (jsonb, migration 0017) and signed into
  links on every read with the reader's claims (ADR 0036). A moment's
  `snapshot_url` is null when there is no picture (sounds) or no video grant.
  Live-look snapshots are deleted with their conversation.
- **Masks.** Model inputs are the media plane's masked analysis frames; event
  snapshots are masked too. Nothing new reaches a model unmasked.
- **Suggested watches** are suggestions only (`propose_watch`, once per
  answer, sources limited to the answer's). Creating one is the client's
  `POST /v1/watches`.
- **Agents.** Agent keys may use conversations; an agent sees only the
  conversations it started (`conversations.agent_id`), account keys only the
  account's own. No new MCP tools: agents already have `look` and
  `what_happened`.
- **Metering and limits.** Each model call is one AI check with detail `chat`
  (`ai_checks_by_kind.chat`); the route is refused with `allowance_exhausted`
  when the quota provider says AI checks are used up, and shares the expensive
  rate-limit bucket with `ask` and memory search.
- **No model configured:** the brain answers with the closest moments from a
  history search, cited the same way, instead of failing.
- **Failure.** If the brain can't answer, the question is removed again (so a
  retry doesn't repeat it) and the caller gets `503 service_unavailable`
  (or an `error` event).

## Consequences
- An answer costs about 2–4 AI checks (one per model call, plus one per live
  look), more than `ask`; the cap of 6 calls bounds it.
- Times in answers use the request's `time_zone` (UTC by default) until the
  account has a time zone of its own.
- The brain that answers must also be the one receiving the camera's frames
  for `look`; with several brains every one receives every frame, as for
  `ask` today.
- Message content keeps `[n]` markers; clients render them as links to
  `moments[n-1]`.

## Addendum (2026-10-16, integration): answer feedback

`POST /v1/conversations/{id}/messages/{mid}/feedback` `{value: helpful |
not_helpful | null}` stores the reader's thumbs on an assistant message
(`messages.feedback`, added to migration 0017 before it shipped); assistant
messages carry `feedback` (null until given). Same access as the conversation
(members and up; an agent only on its own conversations). The console's
thumbs save it.

Times in answers use the request's `time_zone`, else the workspace's
(`accounts.time_zone`, ADR 0044), else UTC. The console sends the browser's
zone, so an answer's times match its moment cards.
