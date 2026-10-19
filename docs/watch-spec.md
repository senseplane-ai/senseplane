# Watch spec

A watch is one plain-language sentence. The compiler turns it into a cheap trigger plus a VLM verification. This shape is public API (`spec/schemas/watch.json`, `spec/schemas/trigger.json`).

### Creating a watch
- **Three ways in, one endpoint underneath:** MCP `watch_for`, `POST /v1/watches`, and the console all call the same thing.
- **Compiling:** an LLM runs once, at creation. Without a model, or when the LLM's answer doesn't validate, a rule-based compiler does it instead. The compiled form is stored and returned, and the user or agent can read and `PATCH` every field.
- **Without a vision model:** watches still fire on their trigger, but a `verify` step can't run, so their events say they weren't verified.
- **No usable trigger:** the watch falls back to a `schedule` trigger, and the response includes a cost estimate.
- **Feedback:** `relevant` / `not_relevant` on events tunes `min_confidence`, counts and durations for that watch.

### Watch object
```json
{
  "id": "wat_01J9...",
  "instruction": "Alert me when more than five people are queuing at reception",
  "sources": ["src_lobby"],
  "mode": "alert",
  "compiled": {
    "trigger": { "type": "objects", "label": "person", "zone": "reception",
                 "min_count": 6, "min_duration_s": 30 },
    "verify": { "prompt": "Are more than five people queuing at the reception desk? Answer yes or no with a confidence.",
                "min_confidence": 0.7 },
    "cooldown_s": 600,
    "active_hours": null
  },
  "estimate": { "vlm_calls_per_day": "4–10" },
  "status": "active",
  "warnings": []
}
```
- **`mode`:** `alert` (the default) posts `watch.triggered` events to the watch's destinations. `track` only records the watch's activities, while its condition holds and has passed its check, so questions can measure them later ("how many meals today?"). It sends nothing, and a check that says no is asked again at most every 2 minutes while the condition holds. Both modes record activities ([Asking about time](activity.md), ADR 0057).
- **`compiled` on create:** `POST /v1/watches` takes a compiled form to use as it is instead of compiling the sentence. It is validated against the spec.
- **`verify`:** optional. When it's absent, the trigger alone fires the event (useful for `sensor` and `sound`).
- **`compiled.active_hours`:** what the compiler read from the sentence. `null` means always on. Otherwise a list of `{days, from, to}` in UTC.
- **`status`:** `active`, `paused` or `needs_zone`.

### Destinations, schedule and several cameras (ADR 0043)
```json
{
  "sources": ["src_front", "src_back"],
  "notify": [{ "type": "webhook", "id": "whk_01J9..." }, { "type": "agent", "id": "agt_01J9..." }],
  "active_hours": { "days": ["mon", "tue", "wed", "thu", "fri"], "from": "18:00", "to": "06:00", "time_zone": "Europe/London" }
}
```
- **`notify`:** where `watch.triggered` goes. Empty (the default, and every
  watch made before destinations) means every webhook subscribed to
  `watch.triggered`. Otherwise only the listed webhooks (whatever event types
  they subscribe to) and agents. An agent's events wait in its inbox, read
  through MCP `what_happened` or `GET /v1/inbox` ([MCP setup](mcp-setup.md#watch-destinations-and-the-inbox)).
  Every event is in the Events feed either way. Other event types (detections,
  sounds, sensor thresholds) keep going to their subscribed webhooks. Ids must
  belong to the account; an agent key may list only itself. A deleted webhook
  or revoked agent stays in the list and is skipped.
- **`active_hours`:** when the watch may fire, in wall-clock time in
  `time_zone` (IANA name, default UTC), so it follows daylight saving. A span
  whose `to` is before its `from` runs overnight and belongs to the day it
  starts on: Friday 18:00–06:00 covers Saturday 03:00. `from` equal to `to` is
  the whole day. `null` means always. It applies on top of
  `compiled.active_hours`.
- **Several cameras:** `sources` takes ids or names. Each camera is watched on
  its own (its own trigger state, cooldown and events), events carry
  `source.name`, and the summary of a watch on several cameras starts with the
  camera's name.

### Testing a watch on recorded history
`POST /v1/watches/test` with `{instruction | compiled | watch_id, sources, from, to}`
(at most 7 days) replays the cheap trigger over what was stored for that range:
the brain keeps one event per detected label per episode (with its zones,
start, end and snapshot) and one per sound, and sensor readings are stored as
they arrive. Motion isn't stored, so a `motion` trigger stands in with
detections in the zone; a `schedule` trigger uses stored snapshots at its
interval. The model check then runs on at most `max_checks` (default 10,
maximum 50) candidate snapshots, each metered as an AI check. The reply has
`matches` (camera, time, summary, signed snapshot link), `checks_used`,
`candidates` and `unchecked`. Without a vision model, candidates come back with
`verified: false`.

### Trigger types
| `type` | Fields | Fires when |
|---|---|---|
| `objects` | `label` (person, vehicle, animal, or one of 64 everyday objects such as cup, laptop, phone, backpack, chair, book: see [Detector labels](api/labels.md)), `zone?`, `min_count` (default 1), `min_duration_s` (default 0), `on`: `enter` / `leave` / `present` / `stationary` | The condition holds for at least `min_duration_s` |
| `motion` | `zone?`, `min_duration_s` | There is movement in the zone |
| `sound` | `class` (crying, glass_break, alarm, dog, speech_present), `min_duration_s` | The class is detected for long enough |
| `sensor` | `sense` (temperature, humidity), `above?`, `below?`, `rate_per_min?`, `min_duration_s` | The threshold or rate of change is crossed |
| `schedule` | `every_min` (minimum 5), within `active_hours` | Always. A snapshot is taken and `verify` is required |
| `sequence` | `steps`: a list of other triggers, `within_s` | The steps happen in order within the time window |
| `condition` | `query` (an [activity question](activity.md)), `test` `{op: lt/lte/gt/gte/eq/ne, value, of?: value/ratio/delta}`, `at` (HH:MM) or `every_min` (default 10), `days?`, `time_zone?` | Checked by the API, not on frames. A daily check (`at`) fires each day the test holds; a repeated one (`every_min`) fires when the test starts to hold. Not while less than half the time asked about was recorded |
| `digest` | `at` (HH:MM), `items`: up to 12 `{label, query}`, `days?`, `time_zone?` | At that time every day: each question is answered, and all of them go out as one event |

Condition and digest watches have no `verify` and no frames. They can't be
tested on recorded history (`POST /watches/test`), but their question can be
tried with `POST /activity/query`. Times are in `time_zone`, else the
watch's `active_hours.time_zone`, else the workspace's.

### Everyday objects
- Every COCO class besides people, vehicles and animals is its own label, so a
  sentence about a thing the detector knows compiles to a cheap `objects`
  trigger instead of a 15-minute scheduled check. The compiler maps everyday
  words to labels (mug → `cup`, mobile → `phone`, sofa → `couch`, television →
  `tv`, computer → `laptop`, bag → `backpack`, fridge → `refrigerator`).
- Left somewhere → `stationary` (60 s unless the sentence says how long);
  taken or gone → `leave` (30 s, so someone standing in front of it is not a
  theft); otherwise `present`. When a person acts on the object ("someone
  takes the laptop") the object is watched.
- Small objects are unreliable at 640x360, so object watches always carry a
  `verify` that names the user's own word and place ("Is there a mug left on
  the desk?").
- A thing that is not a label (keys, a door, a package) still needs another
  trigger plus `verify`.

The package watch is a `sequence`:
1. `objects` person, `on: enter`, zone `front_door`;
2. `objects` person, `on: leave`;
3. `motion` in `front_door`, then `stationary` for 10 s;
4. then `verify`: "Is there a package left on the doorstep?"

### Zones
- Zones are named polygons on a source, set with `PATCH /sources/{id}`.
- If the compiler finds the place named in the sentence among the source's zones, it uses that zone.
- If it doesn't, the watch is saved as `needs_zone`, with a warning telling the user to draw it in the console. It runs on the whole frame until then, and the VLM check covers location.

### What gets delivered
- When the trigger fires and the VLM confirms, a `watch.triggered` event goes out by signed webhook. It carries `summary`, `confidence`, `snapshot_url` and `clip_url`, and `what_happened` can find it.
- `cooldown_s` stops repeat events for the same situation.

### Example watches
| Sentence | Compiles to |
|---|---|
| Reception queue over five people | `objects` person ≥ 6 in `reception` for 30 s, then verify |
| Three or more trucks queuing | `objects` vehicle ≥ 3 in `gate` for 120 s, then verify |
| A mug left on the desk | `objects` cup `stationary` in `desk` for 60 s, then verify "Is there a mug left on the desk?" |
| Someone takes the laptop | `objects` laptop `leave` for 30 s, then verify "Is the laptop gone?" |
| A backpack left by the door for 10 minutes | `objects` backpack `stationary` in `door` for 600 s, then verify |
| Pallet blocking the marked crossing | `sequence`: `motion` in `crossing`, then `stationary` for 300 s, then verify |
| Empty shelf section | `schedule` every 30 min, 08:00–20:00, then verify |
| Cabinet left open / machine fault light red | `schedule` every 5–15 min, then verify |
| Server room above 28 °C | `sensor` temperature, above 28, for 300 s (no verify) |
| Glass breaking | `sound` glass_break (no verify) |
| Track when someone is eating at the table (`mode: track`) | `objects` person `present` in `table` for 60 s, then verify "Is the person eating?", recorded as activities only |
| Nobody in the kitchen by 10am | `condition`: `count` of person in `kitchen` today, `eq 0`, at 10:00 |
| No movement in the hallway for 3 hours | `condition`: `since_last` person in `hallway`, `gte 10800`, every 10 min |
| Eating less than usual (checked at 20:00) | `condition`: `count` of the meal watch with `compare: last_14_days`, `of: ratio`, `lt 0.7`, at 20:00 |
| A summary of Mum's day at 8pm | `digest` at 20:00: first seen, last seen, time seen, longest quiet spell, and a count for each tracking watch |

### Packs

`GET /watch-packs` lists ready-made sets of watches (eldercare, home, shop,
site), and `POST /watch-packs/{id}/apply` with `{sources, items?, time_zone?}`
adds them. Sentences are compiled like any watch, and conditions and digests
are added compiled. A pack's digest summarises its own tracking watches. See
[Asking about time](activity.md#packs).

