# Workflows

"When this happens, do that", without code (ADR 0072). A workflow is a
trigger and a few steps joined into a graph. Draw one on the **Workflows**
page of the console, or send it to `POST /v1/workflows`.

A workflow never switches a device. There is no such step, and the API and
the engine refuse anything that isn't one of the steps below. Switching a
device only happens when a person asks (ADR 0067).

## Triggers

| Trigger | Starts a run |
|---|---|
| `event` | For each event on its cameras and sensors whose type matches `event_types` (`detection.person`, `watch.triggered`, `sensor.*`, `*`), optionally only from some `sources` or one `watch_id` |
| `schedule` | Daily `at` a local time, or `every_min` minutes, on chosen `days`, in a `time_zone` (default the workspace's) |
| `webhook` | When `POST /v1/workflow-hooks/{id}` is called with a signed request (below); the JSON body is the run's `input` |

## Steps

| Step | Does |
|---|---|
| `condition` | Checks rules on the event (`event.labels`, `event.confidence`, `event.reading`…), the webhook's input (`input.door`), the local time (`time.hour`, `time.weekday`) or an ask's answer; goes on along its `yes` or `no` edge |
| `ask` | Asks the vision model a yes/no question about the event's snapshot (or the camera's live frame); one AI check; `yes` or `no` edge |
| `notify` | Sends text to a linked chat (Telegram) or one of your webhooks |
| `speak` | Says text through a camera's speaker, with talk-back's limits; a webhook's `{{input.…}}` only with `allow_input` |
| `clip` | Saves a clip of the event's moment, once it is recorded |
| `story` | Makes a story of the moment on one or more cameras |
| `wait` | Pauses the run, 1 second to 24 hours |

Text can carry `{{event.summary}}`, `{{event.source_name}}`,
`{{input.name}}` or `{{steps.<ask id>.answer}}`. Nothing else in it is
evaluated. A speak step won't say what a webhook sent (`{{input.…}}`)
unless you set `allow_input: true` on it ("Say what the webhook sent aloud"
in the console): otherwise anyone holding the hook secret could make a
camera say anything.

While a workflow speaks through a camera, and for 5 seconds after, that
camera's events don't start that workflow, so it doesn't answer its own
voice. The console warns when a speak step's camera can start the workflow
with sound events.

The graph has no loops: each step runs at most once per run. A step runs
when one of the edges into it was taken, and is skipped otherwise.

## What a run may do

A workflow lists the cameras and sensors it may use (at most 20). Its runs
see nothing else, and follow the same rules as an agent would:

- Cameras with face or plate blurring on stay blurred: asks are blurred, chats
  get no snapshot from them, and clip and story steps on them fail with the
  reason (recordings aren't blurred).
- Sound is only in clips and stories from cameras that record it.
- Speech only on cameras a speak step names, at most 30 seconds, 6 messages a
  minute per camera, after a chime, and kept so a person can hear what was
  said. Say it is an automated message.

Admins and owners make and change workflows; everyone in the workspace sees
them and their runs. Agents can't reach them.

## Runs

Every run is kept for 30 days with each step's status, attempts, timing,
output and error (`GET /v1/workflows/{id}/runs`, `GET /v1/workflow-runs/{id}`).
A failing step fails the run and says why. Steps that are safe to repeat
(asks, webhooks, chats, clips, stories, waits) are tried up to three times;
speech is never repeated. A workflow starts at most 10 runs a minute and 120
an hour (600 an hour per workspace); the rest are dropped and counted on the
workflow. Cancel a run from the console or with
`POST /v1/workflow-runs/{id}/cancel`. Turning a workflow off or deleting it
stops its runs under way, and changes to its sources or speak steps apply to
them from their next step. Runs are kept 30 days, or as long as the shortest
retention of their cameras and sensors if that is less, and forget their
outputs when the event or camera they came from is deleted.

## n8n, Zapier and Home Assistant

**Starting a workflow.** Make one with a `webhook` trigger. Its answer has
`hook_url` and `hook_secret` (shown once; `POST /v1/workflows/{id}/hook-secret`
makes a new one). Sign each request as Senseplane signs its own webhooks:

```
Senseplane-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
```

With curl:

```sh
body='{"door":"front"}'
t=$(date +%s)
sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$HOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST "$HOOK_URL" -H "content-type: application/json" \
  -H "Senseplane-Signature: t=$t,v1=$sig" -d "$body"
```

In n8n, a Crypto node (HMAC, SHA256, hex) over `{{$now.toSeconds()}}.` and
the body, then an HTTP Request node. From code, the SDKs sign for you:
`sp.workflows.trigger(id, secret, input)` (TypeScript) and
`sp.workflows.trigger(id, secret, input)` (Python). A request more than 5
minutes old, signed with the wrong secret, sent twice, or sent to an id that
doesn't exist gets the same 401 and starts nothing; failures are counted on
the workflow (`hook_failures`). Tools that can't compute an HMAC go through one that can.

**Receiving from a workflow.** A notify step to one of your webhooks posts
`{"type": "workflow.notify", "workflow": {...}, "run_id", "step_id", "text",
"event": {...}, "input": {...}, "steps": {...}}`, signed with that webhook's
secret. `Senseplane-Delivery` is the same on every retry, so a receiver can drop
repeats. Check it with `verifyWebhook` (TypeScript) or `verify_webhook_payload`
(Python).
