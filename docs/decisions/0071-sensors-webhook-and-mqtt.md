# 71. More sensors: a signed readings webhook, and MQTT in and out on the box

Date: 2026-11-03 · Status: accepted

## Context

Readings already arrive by push (ADR 0045, 0060): a sensor source's
integration token (`sit_…`) posts `{"readings": [...]}` to
`/v1/sources/{id}/readings`, and the box sends the Home Assistant entities a
person chose (ADR 0061). That suits the Home Assistant integration, but not
the tools people wire sensors with: IFTTT, n8n and Zapier send one flat
object with text values, ESPHome and Shelly scripts have little room for
code, and none of them want to learn the source ID first. Homes without Home
Assistant often have an MQTT broker instead (ESPHome, Tasmota, Zigbee2MQTT,
Shelly all speak it), and homes with one want Senseplane's own events
(someone at the door) back in Home Assistant without writing automations.
The roadmap's "open bridge outputs" asks for exactly that: open standards out
of the box, with Senseplane as one output among them.

## Decision

**One readings webhook.** `POST /v1/integration/readings` takes the sensor's
integration token and files the readings under its source; no source ID in
the URL. The body is `{"readings": [...]}` or one reading's fields, as JSON,
a form, or plain text holding JSON (IFTTT's three content types); a request
without a body may put one reading in the query string. Values may be text
("21.5", "on", "1", and the sense's own words such as "open" or "wet"), a
known number sense may leave out its unit, a device may be flat
(`device_id`, `device_name`), and `measured_at` may be Unix seconds. The
loose form becomes the same checked reading as before, so `video`, `audio`,
`sensors` and `control` are still refused, and so is anything that doesn't
fit its sense. The token is never accepted in the URL, which ends up in logs;
a tool that can't set a header goes through one that can. The existing
per-key rate limit applies.

**Optional signing, the scheme of our own webhooks.** A sensor's token can
carry a signing secret (`POST /v1/sources/{id}/webhook/secret`, shown once,
sealed at rest like webhook secrets). With one, every push carries
`Senseplane-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`,
exactly as Senseplane signs outgoing webhooks, so the SDKs' helpers and
people's existing code work both ways. A push without a body signs its query
string. The time must be within 5 minutes, and each signature is taken once:
the ones seen are kept per token with their time `t` (`reading_signatures`,
pruned by `t` on the API's clock once 15 minutes old, well past the
tolerance), so a captured request can't be sent again. The signature is taken
in the same transaction as the readings, so a push that fails to be stored
doesn't use it up. A body and a query string that both carry a reading are
refused (only one of them would be signed), bodies must be UTF-8, and
`measured_at` must be within a year of now, on every readings path, so a bad
clock can't file readings (or make partitions) decades away. A
token with signing on can use no other endpoint (the older readings route
doesn't check signatures). A rotated token keeps the secret, so rotating
never turns signing off. The bearer token stays required: it says which
sensor; the signature says the body is the sender's and fresh.

**MQTT in.** The bridge connects to a broker (`--mqtt-url`, a username and
password; as a Home Assistant add-on with its `mqtt` option, the Mosquitto
add-on found through the Supervisor's service discovery, `services:
mqtt:want`). It subscribes to Home Assistant discovery
(`homeassistant/<component>/[<node>/]<object>/config`) and reads sensor,
binary_sensor, switch, light, fan, lock, cover, alarm_control_panel and event
entities: their state topic, device class, unit, on and off payloads, room
(the device's suggested area) and name, with the abbreviated keys devices
use (`stat_t`, `dev_cla`, `unit_of_meas`, `~`). Each payload is turned into
the state Home Assistant would show and mapped by the same rules as Home
Assistant's own entities (`homeassistant.ToReading`, tested against
`spec/home-assistant/readings.json`), so senses and units match. A
`value_template` is read only as a JSON path (`{{ value_json.a.b }}`,
`['key']`, `[0]`, and the `float`, `int`, `round(n)`, `lower`, `upper`,
`trim` filters); anything else, Jinja logic included, is never executed and
the entity isn't listed. Malformed configs, wildcards in a state topic, and
components or device classes with no sense are ignored, as are messages over
64 KiB and entities past 2,000; a state topic no entity reads any more is
unsubscribed. Plain topics for devices without discovery are configured as
`TOPIC=SENSE[:UNIT][@JSON.PATH]`; states take on/off, true/false and 1/0 and
only their own sense's words (wet/dry for a leak, not for a door), and an
event sense's `:PAYLOAD` is what it fires on (default ON, press, pressed, 1 or
true), so a button that sends ON then OFF presses once.
The entities are listed like Home Assistant's (`mqtt.<component>_<id>`), and
only the ones a person chooses are sent, through the same path as every
other box sensor. As an add-on, discovered sensors are not listed by default
(`mqtt_sensors`), because Home Assistant already lists those devices and they
would appear twice; plain topics still are.

**MQTT out, only when the account turns it on for that box.** A per-box
setting, `mqtt_publish` (`PATCH /v1/bridges/{id}`, off by default, audited),
lets the box publish this account's events to its broker. The box fetches
them, outbound only: `GET /v1/bridge/outputs` is long-polled like the command
channel (up to 25 s), returns the cameras with their online state, the
watches that alert, and the person, vehicle and animal detections and watch
firings of those watches only (filtered in SQL) after the box's cursor. The
cursor is a position in time, always given (the newest event handed over, or
now): event ids are minted before their transaction commits, so each answer
repeats the 5 s before the cursor and the box drops ids it already took; the
cursor never reaches more than 10 minutes back. Without a cursor it starts
from now, so old events are never replayed into Home Assistant. A waiting
poll is woken in-process when an event is stored for the account or the
setting changes, and otherwise looks again every 5 s (for events stored by
another replica), reading the setting once per look. Events are found by a
`(account_id, id)` index. Off, it answers `mqtt_publish: false` with empty
lists after waiting like a poll for events. Each event carries its age on the
server's clock (`age_ms`), and the answer the server's `now`: the box times a
sensor's hold by that age, not by its own clock, sends no watch firing more
than 5 minutes old, and keeps up to 20 recent firings while its broker is away
to send when it is back. A box that gets an answer without a cursor waits 5 s
before asking again. The box publishes them as
Home Assistant discovery entities, retained, so they appear by themselves:
per camera a device with Person (occupancy), Vehicle and Animal binary
sensors, each on for a minute after one is seen and then off, and Online
(connectivity); per watch an event entity that fires with the event's
summary and camera (not retained). Everything is named after the box (its
bridge id: `senseplane_<box>_<camera>` nodes, `senseplane/<box>/…` topics),
with ids in lowercase base32 so ids that differ only in case or in `-` and
`_` stay apart, and cleanup removes a config only when its node's box part is
exactly this box's, so boxes can share a broker. `senseplane/<box>/status` is the availability
topic: online, offline on a clean stop, and offline as the will, which is set
only once the box may publish (it connects again to set or clear it, with a
clean disconnect so the old will isn't sent). Configs for cameras and watches
that are gone, and every config when publishing is turned off (also those an
earlier run of the box left on the broker), are removed with an empty
retained message; other boxes' are left alone. No Senseplane entity is ever
read back as a sensor. Anyone who can read the broker sees what is
published, which is why the switch is per box and the console says so.

**The MQTT client is `github.com/at-wat/mqtt-go` (Apache-2.0).** Eclipse
Paho (Go) is dual EPL-2.0 / EDL-1.0; taking it under EDL would work but
needs a licence note and an exception in dependency review, while
at-wat/mqtt-go is Apache-2.0 outright, MQTT 3.1.1 (what Mosquitto and Home
Assistant use), context-driven and small, with TCP, TLS and WebSockets. The
bridge keeps its own reconnect loop (backoff from 1 s to 1 min) so it knows
when the link is up and re-subscribes and re-publishes on every connection
and when Home Assistant announces itself (`homeassistant/status`). Tests run
a broker in the test process, `github.com/mochi-mqtt/server` (MIT), as a Go
library; it is never in the bridge binary. The Android app's embedded bridge
doesn't link MQTT.

## Consequences

- Any tool that can POST can be a sensor, with the same checks, rate limit and
  watches as every reading; the recipes are in `docs/sensors-webhook.md`.
- Signing is opt-in and per sensor; tools that can't compute an HMAC (Shelly
  scripts, IFTTT) use the token alone.
- A box with a broker lists MQTT sensors next to Home Assistant's and Matter's,
  and can put Senseplane's events into Home Assistant with no automation.
- A box polls `GET /v1/bridge/outputs` only when MQTT is configured on it; a
  waiting poll costs one short transaction every 5 s unless woken.
- The broker link drops a connection whose publish or subscribe gets no answer
  in 5 s. The broker URL is checked once at start-up and never logged with its
  password (credentials travel apart from it); the password is best given in
  `MQTT_PASSWORD` rather than as a flag.
- **Box sensors from MQTT are online while the broker is reachable.** The
  heartbeat takes an optional `mqtt` field (`connected`, `entities`); the box's
  sensor sources are online while Home Assistant or the broker is reachable.
  The box sends the field only when `GET /v1/bridge/config` lists the
  `health_mqtt` feature: an older API refuses heartbeats with fields it doesn't
  know, and a newer box must not lose its heartbeat against one.
- A box with publishing off publishes nothing, not even a will.
- Two boxes on one account that both publish show each camera twice in Home
  Assistant, once per box; that is what turning it on for both asks for.
- Migrations 0049 (signing secrets, `reading_signatures`) and 0050
  (`bridges.mqtt_publish`).
