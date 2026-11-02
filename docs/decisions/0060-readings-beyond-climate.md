# 60. Readings beyond climate: numbers, states and events

Date: 2026-11-02 · Status: accepted

## Context

Sensor sources took two readings, temperature in Celsius and humidity in
percent, and both were hardcoded in about fifteen places: the spec, the
ingest check, watches, questions, the MCP tool, the console and the Home
Assistant integration. The home box (milestone H) needs the sensors homes
actually have: doors and windows, motion, leaks, smoke and CO, plugs and their
power, locks, doorbells and buttons. Senses were already an open list
(ADR 0009) and the stored `unit` was already free text; only the checks
around them were closed.

## Decision

**Three kinds of reading.** A reading is a `number` (a value in a unit), a
`state` (true or false, with a word for each: a contact's true is `open`, a
switch's is `on`, a lock's is `unlocked`, a leak sensor's is `wet`) or an
`event` (something happened: a doorbell ring, a button press, with an
optional `detail` such as `double`). States follow Home Assistant's "on is
the noteworthy state" rule, so a door sensor's `on` maps straight to open.

**One catalog.** `spec/senses.json` lists the known senses with their kind,
unit (or on/off words), a readable name and the words the rule-based watch
compiler matches. It is copied to the API and the brain and generated into
the SDK, which the console and the MCP server use. A sense that isn't in the
catalog is still taken, with the kind its value implies and, for a number,
any unit token; known senses must use their kind and unit (power in watt,
not kW), so values stay comparable. Integrations convert.

**Devices.** A reading may name the device that measured it (`device: {id,
name}`), for a source fed by several entities (a Home Assistant entity, a
Matter node). The latest reading, watch runs and question spans are kept per
sense and device. A reading without a device gives way to a newer one of the
same sense that names it, so integrations can start naming devices without
leaving a stale value behind.

**Storage.** `sensor_readings` gains `kind`, `device_id`, `device_name` and
`detail` (migration 0029). States are stored as 1/0 and events as 1, so the
value column, the partitions and the retention sweep are unchanged. A state
in latest readings also says `since` when it has held.

**Sensors gain senses.** A sensor source gains each new sense its readings
bring, instead of refusing them. Grants still decide who sees what.

**The `sensors` grant.** A grant may name `sensors`, which covers every
sensor sense, including ones a source gains later, and never video or audio.
The console's "Read environment" permission becomes "Read sensors" and grants
`sensors`; older grants that name temperature or humidity keep working and
read as "Read sensors".

**Watches and questions.** A sensor trigger takes `above`/`below` for numbers,
`state` for states (true by default) and fires once per run that holds for
`min_duration_s` ("the garage door is left open for 10 minutes"), or on every
event (optionally only one `detail`). It may name a `device`. Activity
questions take the same `sensor` filter: a state is a span while it holds,
continuing from the last reading before the window; an event is a moment. So
"how many times was the fridge opened today?" is a count of contact spans,
and "tell me if the fridge hasn't been opened by 10am" is a condition watch.
The rule-based compiler maps sentences to sensor senses only when the
sources have them, so a camera's "front door" stays a camera watch.

**Reading now.** `read_environment` (MCP) and a new `read_sensors` chat tool
return every sensor sense: numbers with their trend, states with since when,
the last event.

## Consequences

- Clients reading `/now`, `/history` or event values see `kind` on every
  reading and `value: true/false` for states; numbers are unchanged.
- `rate_per_min` is still in the trigger spec and still not evaluated.
- Device names come from the integration; renaming the entity starts a new
  name, not a new device (the id is the entity id).
- Not yet: offline coverage for sensors (a box that is off should read as
  "can't check", milestone H), and switching devices (milestone C).
