# 57. An activity timeline, and questions answered from it

Date: 2026-10-19 · Status: accepted

## Context

Most questions people ask their cameras are about time spans, not moments:
how long she slept, how many meals today, the longest time with nobody in
the shop, whether it is quieter than usual, and whether the pills were
taken after breakfast. Events (ADR 0007) record one moment per label per
episode, and every label in an episode shares the episode's end time. Zones
are only looked at when the event is created. A watch only says that its
condition started. So "how long", "how often", "hasn't happened" and
"compared with usual" had no data to work from, and the chat model was left
to count events itself.

## Decision

**Intervals.** The brain reports **activities**: one thing, in one place,
from a start to an end. Each kind uses a gap to decide when one activity ends
and the next begins.

- **Presence:** a label (person, vehicle, animal or an everyday object) in
  view, and in each zone it is in, from the first frame a confirmed track
  that scores high enough to post events is there, until none has been there
  for a gap: 15 s for people, vehicles and animals, 30 s for objects. Each
  activity carries the largest number seen at once.
- **Sound:** a sound class above its threshold, until it has been quiet for
  10 s.
- **Watch:** while a watch's condition holds and has passed its check. A
  condition that holds for a moment only (enter, leave, a sequence, a
  schedule) gives an activity with no length.

The brain sends `brain.activity` messages when an activity opens, every
60 s while it stays open, and when it closes. The API keeps one row per
activity. It closes an activity that has had no update for 3 minutes at the
last time it was seen, which covers a brain that stops or a camera handed to
another brain. Rows of the same thing that are only a gap apart, such as a
handover, are merged when they are read. Sensor readings are already stored
as they arrive, so their spans above or below a threshold are worked out
from the readings when a question is asked.

**Coverage.** Recorded segments say when a camera could see (the same
ranges as `GET /v1/sources/{id}/timeline`). Every answer reports what share
of its window was recorded and where the gaps were. "It didn't happen" is
only said when the camera was recording.

**Watches that track.** A watch's `mode` is `alert` (as before: an event
and notifications) or `track`, which only records activities to answer
questions later. A tracking watch whose check fails asks again at most
every 2 minutes while its condition holds, so "eating at the table" is found
once the person starts eating. **Packs** are ready-made sets of watches for
a use case (eldercare, home, shop, after-hours site), added in one step.

**Questions.** `POST /v1/activity/query` takes a structured question, and
the chat, MCP and REST all use the same one. The language model only writes
the question; the API does the counting. A question has:

- **`measure`:** `exists`, `count`, `first`, `last`, `since_last`,
  `total_duration`, `longest`, `average_duration`, `longest_gap`, `timeline`
  or `sequence` (one thing, then another within a time).
- **`what`:** a presence label, a watch, a sound or a sensor threshold.
- **`where`:** cameras, zones and sites.
- **`when`:** a period or a range in a time zone, and an optional daily time
  window, such as nights only.
- **`group_by`:** hour, day, weekday, camera, zone or site.
- **`compare`:** the previous period, the same weekday over 4 weeks, or the
  last 14 or 28 days. With `compare`, the reply includes the baseline, the
  ratio to it and a trend.

Each reply carries the value, the activities behind it as evidence, and the
coverage. The chat also gets `check_history`, which runs a plain-language
check over recorded footage (the watch backtest) when nothing tracked the
thing at the time.

**Conditions and digests.** Two more kinds of trigger run in the API on a
schedule:

- **`condition`:** a question, a comparison and when to check it. This one
  shape covers count, duration, absence ("no one in the kitchen by 10:00")
  and trend watches ("meals below 70 % of usual").
- **`digest`:** a few questions answered at a time of day and delivered as a
  `watch.triggered` event, to the same webhooks and agent inboxes as any
  other watch.

**Sites.** Each source can belong to a site, so questions can be filtered
and grouped across places.

## Consequences

- Duration, count, absence, first and last, order, trends and comparisons
  are all one query engine. New ways of asking need no new storage.
- Answers are exact and say when coverage was incomplete. The model no
  longer adds up events.
- Activities are stored rows, partitioned by nothing yet: one row per thing
  per span, far fewer than frames or segments. They are deleted with the
  source's other data, by the same retention.
- Activities have no identity. "Mum" only means the person in a place, which
  holds when one person lives there; the chat says so when it can't tell.
- Tracking watches use model checks like alert watches. Their cost is
  bounded by the trigger, the re-check interval and the account's AI checks.
