# 62. Matter devices through the bridge, and work for a box

Date: 2026-11-02 · Status: accepted; its "read-only" rule is superseded by ADR 0067 (switching a device when a person asks)

## Context

Homes without Home Assistant have Matter devices too: plugs, door sensors,
locks and buttons already set up in Apple Home, Google Home or the maker's
app. Matter lets one device belong to several controllers at once
(multi-admin), so Senseplane can read them alongside those apps without
replacing them. A box with Home Assistant already gets its Matter devices as
Home Assistant entities (ADR 0061). The bridge is a small static Go binary,
and there is no mature Matter controller library for Go.

## Decision

**A Matter Server, not a Matter stack in the bridge.** The bridge talks to a
Matter Server over the WebSocket API Home Assistant's Matter integration
uses (`matterjs-server`, Apache 2.0, or `python-matter-server`), with
`--matter-url ws://…:5580/ws`. The server holds the Matter fabric, the
commissioning and the device subscriptions; the bridge stays small and
outbound, and either server works. Running one needs host networking (mDNS
and IPv6 on the home network); Bluetooth is not needed for devices shared
from another app.

**Devices are sensors like any other.** The bridge lists each node's
endpoints that map to senses (ADR 0060) as entities
(`matter.n<node>_e<endpoint>_<sense>`, named after the device's label) and
sends readings only of the ones a person chose, as for Home Assistant:

| Matter | Sense |
|---|---|
| On/Off | `switch` |
| Boolean State on a contact sensor (true is in contact: closed) | `contact` |
| Boolean State on a water leak detector | `leak` |
| Occupancy Sensing | `occupancy` |
| Temperature, Relative Humidity, Illuminance, Pressure measurement | `temperature`, `humidity`, `illuminance`, `pressure` |
| Electrical Power Measurement (active power, voltage, current) | `power`, `voltage`, `current` |
| Door Lock | `lock` |
| Smoke CO Alarm | `smoke`, `carbon_monoxide` |
| Power Source battery | `battery` |
| CO2, PM2.5 concentration | `co2`, `pm25` |
| Switch events (short, long, multi press) | `button` with `long`, `double`, `triple` |

The bridge never sends a device command: reading only, until switching comes
with a person asking (milestone C).

**Adding a device with a code.** A person shares the device from its own app
(or uses its label), pastes the code on the box's page, and the box
commissions it over the network (`commission_with_code`, network only).
Failures come back in words: the code doesn't match, the device wasn't
found (pairing mode off, another network), it timed out.

**Work for a box.** The code reaches the box through a new channel: the API
keeps `bridge_commands` (arguments sealed with `SECRETS_ENCRYPTION_KEY`), the
box long-polls `GET /v1/bridge/commands?wait=25` (outbound, answered as soon
as there is work), takes each command once (its arguments are then cleared)
and reports `POST /v1/bridge/commands/{id}`. A kind the box can't do is
reported failed, never left waiting. Switching devices (milestone C) will use
this channel.

**Only where it applies.** A box reports `matter` in its health when it runs
a controller; the console offers adding Matter devices only on those boxes.

## Consequences

- Tested against a fake server speaking the protocol and, opt-in
  (`MATTER_URL`), against a real Matter Server and a matter.js example plug;
  real devices are the acceptance test.
- Thread devices work when the home's Thread border router shares its
  network with the Matter Server; that is the server's setup, not the
  bridge's.
- Matter has no rooms, so a box's Matter devices go to its "Home sensors"
  source unless Home Assistant provides them instead.
