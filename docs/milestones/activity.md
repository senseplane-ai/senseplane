# A: the activity timeline — results

Date: 2026-10-19. Done-when: *"How many meals today?", "How long did she
sleep?" and "Is it quieter than usual?" are answered exactly, with evidence
and coverage, on the fixtures.*

[ADR 0057](../decisions/0057-activity-timeline.md) describes the design, and
[Asking about time](../activity.md) shows how to use it. `e2e/activity-check.ts`
runs it through the real pipeline: the dev replay, media, the brain with its
detector cascade and sound classifier, then the API. Its checks:

| Check | Result |
|---|---|
| A person at the door is one presence activity, close to when they were there | **Pass.** One activity for the whole view. It starts 8.7 s into the file (the labels say 7.8 s, plus about a second for the replay to start) and lasts 18.3 s (the labels say 19.7 s) |
| The zone they stood in has its own activity | **Pass.** `doorstep` |
| A vehicle and a sound give activities | **Pass.** The van: 26.6 s. Crying: 22.6 s |
| A tracking watch records, and posts nothing | **Pass.** 18.2 s, and no `watch.triggered` |
| Questions answer with the right numbers | **Pass.** `count` gives 1; `total_duration` in the zone gives 18.3 s; the tracking watch's count is 1; `longest_gap` gives 58.5 min of the hour; `group_by: source` lists every camera at the site, with 0 for the nursery |
| Coverage is reported | **Pass.** The cameras recorded 0.9% of the last hour, so the answer says `complete: false`, lists the gaps and adds a note |
| A condition watch fires on its own | **Pass.** The API's scheduler checked it and posted "Someone came to the door: 1 time." |
| A condition watch doesn't judge what it couldn't see | **Pass.** "No one at the door in the last hour" stays quiet when only 1% of that hour was recorded |
| The chat answers from activities | **Pass, with a real model.** "How long was someone at the front door in the last hour?" got "about 20 seconds, from 03:56:43 to 03:57:03 [1]", and it said the camera had recorded only about 1% of the hour, so the figure isn't reliable. "How many times…" got "once", with the same note. Both cite the activity as a span. The answers are recorded for replay |

Unit and integration tests cover the rest:

- **Brain:** spans opening, beating and closing; presence and zones on the
  fixtures; tracking watches asking again while their condition holds; no
  cooldown for tracking; the chat tools.
- **The query engine on hand-made data:** windows in a time zone across
  daylight saving; nightly windows; merging pieces; every measure;
  `group_by`; comparisons with what is usual and trends; days the camera was
  off left out of what is usual; sequences; coverage; sensors.
- **API against Postgres:**
  - activities only move forward and reopen after a stale close;
  - grants limit senses, cameras and time;
  - history checks keep a tracking watch's activities without counting them
    twice;
  - condition watches: once a day, on transition, and not fired when coverage
    is too low;
  - digests, and packs.
- **MCP:** `measure` and `check_history`.
- **Console:**
  - mode on create and switching mode;
  - packs;
  - the camera's Activity tab;
  - sites.

## What was built

- **Activities** from the brain: presence per label and per zone, sounds,
  and a watch's span while its condition holds. Stored as one row per
  activity, closed after 3 quiet minutes, and readable at `GET /v1/activities`.
- **One query engine** (`POST /v1/activity/query`) for exists, count, first
  and last, since last, total, longest and average duration, longest gap,
  timeline, sequence and sensor values. Each answer can be grouped by hour,
  day, weekday, camera, zone or site, and compared with the previous period,
  the same weekday or the last 14 or 28 days, which gives a trend. It reports
  coverage and evidence.
- **Tracking watches** (`mode: track`), and **packs** for eldercare, home,
  shop and site.
- **Checking history after the fact** (`POST /v1/activity/check`).
- **Condition and digest watches**, checked by the API on a schedule. They
  compile from plain sentences such as "nobody in the kitchen by 10am", "no
  movement for 3 hours" and "a summary of the day at 8pm".
- **Chat tools** `query_activity` and `check_history`. Answers cite spans.
- **MCP tools** `measure` and `check_history`, and `mode` on `watch_for`.
- **Sources have a site.**
- **Console:** an Activity tab on each camera with a day strip; Alert or
  Track when making a watch; Add a pack; the Site setting.
