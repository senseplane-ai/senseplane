# H. Home box and more sensors (2026-11-02)

Done-when: *on a Home Assistant Green with no radio sticks, an RTSP camera
and a Wi-Fi door sensor are linked with one code; "has the fridge been
opened today?" is answered from the sensor; an absence watch says it can't be
checked while the box is off.* Built and tested against a real Home Assistant
(2026.10.4, its demo devices) in the e2e suite; the run on a Green with real
devices is still to do (below).

## What was built

- **Readings beyond climate** (ADR 0060): numbers in any unit, on/off states
  (door, motion, leak, smoke, plug, lock, …) and events (doorbell, button),
  from one catalog (`spec/senses.json`), each with the device that measured
  it. States hold until they change, so "the door has been open since 07:55"
  and "how many times was the fridge opened" come from the readings. Sensor
  watches take states ("left open for 10 minutes") and events; the rule
  compiler maps sentences to them only when the sources have those senses.
  A `sensors` grant covers every sensor sense; the console's permission is
  "Read sensors". `read_environment` and a new chat tool, `read_sensors`,
  read them now.
- **The bridge reads Home Assistant** (ADR 0061): through its websocket API
  (as an add-on, through the Supervisor), with rooms from the area registry.
  It lists the entities Senseplane can take and sends only the ones a person
  chose; the API files them on one sensor source per room. The mapping is
  shared with the custom integration (`spec/home-assistant/readings.json`).
- **One code** (ADR 0061): a box without a token shows a code on its panel;
  an admin enters it at `/link`; the box collects its token once and keeps it.
  Cameras are added on the box's page with their RTSP address.
- **The add-on** (`integrations/home-assistant-addon/`, image
  `ghcr.io/senseplane-ai/bridge-addon`, amd64 and arm64): set the server,
  open its panel, enter the code.
- **Coverage**: a box's health builds spans of "could read Home Assistant";
  questions about its sensors count only those as seen, and a condition watch
  that can't tell sends `watch.unchecked` where its alerts go, never "nothing
  happened". The sensor tools say when a box is offline.
- **Matter** (ADR 0062): with a Matter Server, the bridge reads Matter
  devices as sensors too, and adds one with a code shared from its own app.
  Work reaches a box through a long-polled command channel, which device
  control (milestone C) will use.

## Results

| Check | Result |
|---|---|
| API (`vitest`) | 250 pass |
| Console | 168 pass |
| Brain | 104 pass (sensor compiler and `read_sensors` included) |
| Bridge (`go test -race`) | all packages pass; Home Assistant client against a fake server, Matter client against a fake Matter Server |
| Home Assistant integration | 51 pass, against the shared mapping vectors |
| e2e `ingest` | home sensors: states per device, a "left open" watch, the doorbell, "fridge opened twice", `read_environment` with states |
| e2e `home` (real Home Assistant 2026.10.4) | pairs with a code, lists 30 demo entities with rooms, a chosen light switched in Home Assistant arrives as on/off, an unchosen one never leaves, the pairing survives a restart, the room reads offline when Home Assistant stops |

Found by the tests and fixed on the way: the bridge image couldn't write a
fresh `/data` volume as nonroot (the state dir now ships owned by nonroot);
command arguments were cleared before they were handed over; a chat test and
a camera test that aged out with the calendar.

## Still to do by hand

1. **A Home Assistant OS VM or a Green**: add the add-on repository (after
   publishing `integrations/home-assistant-addon/` to
   `senseplane-ai/home-assistant-addons` and a release that builds
   `bridge-addon`), set the server, pair, choose the Shelly door sensor, open
   the fridge, ask "has the fridge been opened today?". Stop the add-on and
   check an absence watch says it can't check.
2. **A Tapo camera through the box**: add its RTSP address on the box's page.
3. **Matter**: run a Matter Server next to a bridge container, share the
   Shelly plug from its app, add it with the code; and the opt-in live test
   (`MATTER_URL=… go test -run Live ./internal/matter/`), which couldn't be
   run here.
