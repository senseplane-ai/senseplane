# 72. Workflows: "when this happens, do that", never switching a device

Date: 2026-11-03 · Status: accepted

## Context

Watches tell people and systems that something happened (ADR 0043, 0059,
0069). People then want a few steps after that without writing code: "when
someone is at the door after 22:00, ask whether they carry a parcel; if so,
tell the family chat and say 'leave it by the gate'; otherwise post to my
n8n flow". The tools that do this already (n8n, Node-RED, Windmill) are
under licences we can't ship (n8n's Sustainable Use, Windmill's AGPL) or are
single-tenant (Node-RED), and none knows our grants, privacy masks, blurring
or speak rules. The roadmap's one hard line holds: Senseplane senses, and
switches a device only when a person asks (ADR 0067).

## Decision

**A small engine of our own, on the Postgres background jobs (ADR 0058).** A
workflow is a trigger and a graph of steps (`spec/schemas/workflow.json`,
tables `workflows`, `workflow_runs`, `workflow_run_steps`, migration 0056).
Runs are rows claimed by one API process with `claim_workflow_runs`
(`FOR UPDATE SKIP LOCKED`, a lease and a claim token, a SECURITY DEFINER
function with EXECUTE revoked from PUBLIC), and schedules with
`claim_workflow_schedules`. Only the holder of the current token writes a
run's steps; a process that lost its lease (it hung past it and another took
the run over) stops at its next write and writes nothing.

**Triggers.**
- `event`: any event the account stores (a detection, a sound, a watch
  firing, a sensor reading over a threshold), filtered by event type
  patterns (`detection.*`, `watch.triggered`, `sensor.*`) and by source. The
  run is queued in the event's own transaction.
- `schedule`: `every_min` or a daily `at`, on chosen days, in a time zone,
  with the same rules as condition and digest watches.
- `webhook`: `POST /v1/workflow-hooks/{id}`, so n8n, Zapier or Home
  Assistant can start one. It takes no API key: it must be signed with the
  workflow's own secret (`whsec_…`, shown once, sealed at rest) exactly as
  Senseplane signs its webhooks, `Senseplane-Signature: t=<unix
  seconds>,v1=<hex HMAC-SHA256 of "t.body">`, within 5 minutes, and each
  signature is taken once (`workflow_hook_signatures`, pruned after 15
  minutes). Unsigned, stale, wrong or replayed requests are 401 and start
  nothing. The JSON body (at most 64 KiB, an object) is the run's `input`.

**Steps** (a small set, each tested):

| Step | Does | Retried |
|---|---|---|
| `condition` | rules on the event, the input or the local time; branches `yes`/`no` | no need |
| `ask` | a yes/no question to the vision model about the event's snapshot (the backtest check, `rpc.brain.check`) or, without one, the camera's live frame (`rpc.brain.ask`); counts as an AI check; branches `yes`/`no` | on a brain timeout |
| `notify` | a linked chat (through the channel outbox, ADR 0059) or one of the account's webhooks, signed as every Senseplane webhook, with `Senseplane-Delivery` stable across retries so receivers can drop repeats | webhook: network, 429, 5xx |
| `speak` | says text through a camera's speaker, through the talk-back path (ADR 0069) with its limits | never: a message plays once or not at all |
| `clip` | saves a clip of the event's moment, once it is recorded | yes |
| `story` | makes a story of the moment on one or more cameras (ADR 0070) | yes |
| `wait` | pauses the run, 1 s to 24 h, holding no claim | yes |

Text in `notify` and `speak` may use `{{event.summary}}`, `{{input.x}}`,
`{{steps.<id>.answer}}` and the like; nothing else is evaluated.

**No step can switch a device, anywhere.** The schema's step kinds are a
closed list without `control`; the API validates every definition against
the schema and refuses unknown kinds; the engine validates the definition it
runs again (a row written around the API, or by an older or newer version,
fails before any step runs) and has no code path for any other kind. No
workflow file imports the device code or writes device commands, and a test
checks that, as ADR 0067's test does for the other background code.

**The graph is a DAG.** Edges go from the trigger or a step to a step;
`yes`/`no` edges only from `condition` and `ask`. Cycles, unknown ids,
duplicate edges, unreachable steps and more than one trigger are refused at
save time (400 `validation_failed`, with the problem named), and checked
again by the engine. Steps run one at a time in topological order; a step
runs when one of its incoming edges was taken, and is skipped otherwise.

**Who it runs as.** A workflow belongs to the account. Admins and up (and
workspace keys) create, edit, enable and delete them; members and viewers
see them and their runs; agents can't reach the routes. A workflow keeps
running after the person who made it leaves: the account owns it, and the
audit log says who made and changed it. Each run acts as `workflow:<id>`,
an agent-like principal whose grants are rebuilt before every step from the
sources the workflow names (at most 20), as they are then:

- `video` and `sensors` on each named source; `audio` only on cameras that
  record sound (the audio opt-in); `speak` only on cameras a speak step
  names. Nothing outside the named sources: an event from another camera
  never starts it, and a step can't name one.
- Cameras whose blurring is on (ADR 0068) are blurred-only for the workflow:
  asks are blurred, chats get no snapshot, and clip and story steps on them
  fail with the reason (recordings aren't blurred). Privacy masks apply as
  they always do, to every frame and snapshot the brain sees.
- Stories and clips need the same video grant over the moment as an agent
  would; speech needs a camera with a speaker and obeys its rate (6 a minute
  per camera), its 30 seconds, one speaker at a time and its audit.

**Limits.** 100 workflows per account, 20 steps and 40 edges each. A
workflow starts at most 10 runs a minute and 120 an hour, and an account 600
an hour; triggers over that are dropped and counted on the workflow
(`runs_dropped`), and the webhook trigger answers 429. 3 attempts for a step
that may be retried (5 s, then 30 s), then the run fails.

**Runs are recorded.** Each run keeps a copy of the definition it ran, what
started it, and per step its status (`running`, `waiting`, `succeeded`,
`failed`, `skipped`), attempts, start and end, output and error. A failing
step fails the run with the step and the reason; the steps after it are
skipped. A step found `running` when a run is taken over (its process died)
is run again if it may be retried, and otherwise failed with "it may or may
not have happened". Runs are kept 30 days.

**Surfaces.** REST (`/v1/workflows`, `/v1/workflows/{id}/runs`,
`/v1/workflow-runs/{id}`, `POST /v1/workflows/{id}/run` to start one by
hand, `POST /v1/workflows/{id}/hook-secret`, `POST /v1/workflow-hooks/{id}`),
both SDKs, and a canvas editor in the console (React Flow, `@xyflow/react`,
MIT) with the runs and each step's outcome. No MCP tools: workflows are
workspace settings, made by admins, and agents have their own watches.

## Consequences

- Automations that tell people, systems and cameras' speakers need no other
  tool; n8n, Zapier and Home Assistant start them with a signed webhook and
  receive from them with Senseplane's signed webhooks.
- A webhook step to n8n that calls the workflow back makes a loop outside
  Senseplane; the run limits bound it.
- A workflow made by an admin can speak through any camera with a speaker it
  names; that is admin's power, and every message is kept and audited.
- Not yet: email, SMS, Slack and other channels, agents' inboxes as a step,
  parallel branches, loops, and a camera going offline as a trigger.
