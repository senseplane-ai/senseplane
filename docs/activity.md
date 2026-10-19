# Asking about time: activities

Most questions about cameras are about time: how long, how often, since
when, and whether this is usual. Senseplane answers them from **activities**:
one thing, in one place, from a start to an end
([ADR 0057](decisions/0057-activity-timeline.md)).

| Kind | What it is | Ends when |
|---|---|---|
| Presence | A person, vehicle, animal or one of 64 everyday objects ([labels](api/labels.md)) in view. There is one activity for the whole view and one for each zone it is in, with the largest number seen at once | It has been gone for 15 s (people, vehicles, animals) or 30 s (objects) |
| Sound | Crying, glass breaking, an alarm, a dog barking or people talking (never what they say) | It has been quiet for 10 s |
| Watch | While a watch's condition holds and has passed its check | The condition stopped holding 60 s ago |

Sensor readings are measured too: their averages, and the spans above or
below a threshold.

The answers are exact: the API does the counting, not a language model.
Every answer also says what share of the time was recorded. A camera that was
off can't say that nothing happened.

## Ways to ask

- **The chat** in the console, and the Ask API. The model picks the question
  shape; the numbers come from the API.
- **MCP:** the `measure` and `check_history` tools ([MCP tools](api/mcp-tools.md)).
- **REST:** `POST /v1/activity/query`, and `GET /v1/activities` for the list
  ([API guide](api/README.md#activities-and-questions)).

## What you can ask

| Shape | `measure` | Example |
|---|---|---|
| Did it happen | `exists` | "Did anyone come to the door today?" |
| How many | `count` | "How many meals has she had today?" |
| When, first or last | `first`, `last` | "When did the first customer arrive?" |
| How long since | `since_last` | "How long since anyone was in the kitchen?" |
| How long | `total_duration`, `longest`, `average_duration` | "How long did she sleep?" (with `between` 21:00–09:00) |
| How long with none | `longest_gap` | "What was the longest time with no one in the shop?" |
| One, then another | `sequence` | "Did she take her pills after breakfast?" |
| The list | `timeline` | "When was the dog on the sofa today?" |
| Sensors | `average_value`, `min_value`, `max_value` | "How cold did the bedroom get last night?" |

Each of these can also be:

- **grouped** with `group_by`: per hour, day, weekday, camera, zone or site.
  "Which hour was busiest?", "Which shop opened last?"
- **compared** with what is usual, using `compare`: the previous period, the
  same weekday over four weeks, or the last 14 or 28 days. The answer then
  has the usual value, the ratio to it and a trend. "Is she eating less than
  usual?", "Did she get up later than usual?" Days the camera was mostly off
  are left out of what is usual.

```bash
curl -s -X POST "$API/v1/activity/query" -H "Authorization: Bearer $SENSEPLANE_API_KEY" \
  -H "content-type: application/json" -d '{
    "measure": "count", "what": {"watch_id": "wat_…"}, "period": "today",
    "time_zone": "Europe/London", "compare": "last_14_days"
  }'
# {"value": 2, "unit": "count", "baseline": {"mean": 3, "ratio": 0.67, …},
#  "coverage": {"recorded": 0.97, "complete": false, "gaps": […]}, "evidence": [ … the two meals … ], …}
```

## Tracking what matters

Presence covers "someone", "a car", "the dog" and everyday objects. For an
activity, such as eating, taking pills, a queue at the till or someone lying
in bed, make a **tracking watch**. It is a watch with `mode: "track"`: it
records when the thing happens and sends no notifications.

```bash
curl -s -X POST "$API/v1/watches" -H "Authorization: Bearer $SENSEPLANE_API_KEY" \
  -H "content-type: application/json" \
  -d '{"instruction": "Track when someone is eating at the table", "sources": ["Kitchen"], "mode": "track"}'
```

From then on, "how many meals", "how long was lunch" and "fewer than usual"
are answered from its activities. A tracking watch whose model check says no
asks again at most every 2 minutes while its condition holds. Someone who
sits down at the table and starts eating a minute later is still recorded.

For something nothing was tracking, such as "did she take her pills this
morning?" on the first day, **check history**. `check_history` in the chat
and MCP, and `POST /v1/activity/check` in REST, run the watch's model check
over recorded footage. It covers moments when a person, vehicle, animal,
object or sound was detected, at most 10 checks by default, each an AI check.
With a `watch_id`, what it finds is kept as that watch's activities.

## Alerts and summaries about time

Two more kinds of watch are checked by the API on a schedule. Each one is a
question plus a test, and it fires a `watch.triggered` event that goes to the
watch's webhooks and agents. Write them in plain words like any watch, or
send them compiled ([watch spec](watch-spec.md#trigger-types)):

- **Absence by a time:** "Tell me if nobody has been in the kitchen by 10am."
- **No one for a while:** "Tell me if there is no movement in the hallway for
  3 hours." This one fires once when it starts to hold, not every time it is
  checked.
- **Counts, durations and trends:** "Tell me at 8pm if she has eaten less than
  usual."
- **Digests:** "Send me a summary of Mum's day at 8pm." This answers a few
  questions, such as first seen, meals, medication and the longest quiet
  spell, in one event.

A condition doesn't fire while less than half its time was recorded. It
can't tell then.

## Packs

A pack adds a set of watches for a use case in one step (`GET /v1/watch-packs`,
`POST /v1/watch-packs/{id}/apply`, or **Watches → Add a pack** in the console):

| Pack | Adds |
|---|---|
| `eldercare` | Tracking meals, medication and time in bed; alerts for someone on the floor, a smoke alarm, three quiet hours in the day and no one up by 10:00; a summary at 20:00 |
| `home` | Parcels at the door, pets on the sofa, arrivals, glass breaking; a summary at 21:00 |
| `shop` | Queues at the till (tracked, plus an alert for a long one), no one in by 09:30; a trading-day summary compared with the same weekday |
| `site` | People, vehicles and loitering out of hours; a report on the night at 07:00 |

Zones named in a pack's watches (the table, the till, the gate) are used when
the camera has them. Otherwise the whole view is watched and the model check
covers the place.

## Things to know

- **No identity.** Activities don't say who. "Mum" only means the person seen
  in her flat, which holds when one person lives there.
- **Coverage.** Every answer has `coverage.recorded`, the share of the time
  asked about that was recorded, and the gaps. The chat says when part of the
  time is unknown.
- **Grants apply.** An agent sees presence and watch activities only with
  video on that camera, and sounds only with audio, each within its grant's
  time window.
- **Cost.** Presence and sound activities cost nothing extra. Tracking watches
  use model checks like alert watches. Questions and condition watches use
  none; history checks do, one AI check per moment checked.
