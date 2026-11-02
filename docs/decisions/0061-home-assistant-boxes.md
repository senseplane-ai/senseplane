# 61. Home Assistant boxes: the bridge reads Home Assistant and pairs with a code

Date: 2026-11-02 · Status: accepted

## Context

Milestone H puts one always-on box in a home, such as a Home Assistant Green
with no radio sticks, that relays IP cameras and forwards sensors, linked
with one code. The bridge (ADR 0045) relayed cameras with a pasted token,
and the Home Assistant integration sent temperature and humidity to one
sensor source with its own token. A person setting up a box shouldn't have
to copy tokens between two systems, and shouldn't have to send every sensor
in the house to get one.

## Decision

**The bridge reads Home Assistant.** With `--ha-url` and `--ha-token`, or as
a Home Assistant add-on (the Supervisor's `ws://supervisor/core/websocket`
with `SUPERVISOR_TOKEN`), the bridge opens Home Assistant's websocket API. It
subscribes to state changes before taking the snapshot, reads the area,
device and entity registries for each entity's room, and reconnects with
backoff (an auth failure waits five minutes). It is read-only: it never calls
a service. The mapping from entity states to readings (ADR 0060) is the same
in Go and in the Python integration, and both are tested against
`spec/home-assistant/readings.json`.

**People choose; nothing else leaves.** The bridge lists the entities
Senseplane can take (`PUT /v1/bridge/entities`: id, name, room, sense, kind)
and sends readings only of the ones a person chose
(`GET /v1/bridge/config` → `sensors`). The API also files only readings of
chosen entities and of their own sense, so a bridge that sent more would
still store nothing extra. A newly chosen entity sends its current state at
once.

**One sensor source per room.** A chosen entity goes to the sensor source of
its Home Assistant area on that bridge ("Kitchen sensors", location
Kitchen; no area: "Home sensors"), made on first use. Rooms are what grants,
`read_environment` and questions already work with; each entity is the
reading's device, so a kitchen holds its fridge door and its temperature
apart. Dropping an entity keeps what was stored.

**Pairing with a code.** A box without a token asks for one
(`POST /v1/bridge/pair`, no authentication, 20 an hour per address): it
shows an eight-character code without vowels or look-alike characters
(`BCDF-GHJK`) and a link to the console's `/link?code=…`, and polls every
5 s. A workspace admin enters the code, sees the box's name and connects it
(`POST /v1/bridges/pair`); the API makes a bridge, seals its token with
`SECRETS_ENCRYPTION_KEY`, and gives it to the box once on its next poll,
then clears it. The person never sees the token. Codes last 15 minutes. A
pairing has no account until it is approved, so its table has row security
with no policy and is reached only through four `SECURITY DEFINER`
functions. The box keeps its token in `--state-dir` (the add-on's `/data`,
mode 0600); if the API later refuses it (the bridge was removed), the box
forgets it and pairs again. A bridge started with `--token` behaves as
before.

**Cameras on the same box.** A paired box is an ordinary bridge: its
cameras are added with `bridge_id` and an RTSP URL, so one code links both.
A deployment without WHIP still pairs boxes for sensors; their config simply
has no cameras.

**The box's page.** The bridge serves a small status page on its listen
address (the add-on's panel): the code while it waits, then whether it is
connected and how many sensors are sent.

## Consequences

- Health reports say whether Home Assistant is connected and how many
  entities are listed and sent; the console shows it. A box that is off
  still needs to read as "can't check" in answers (milestone H, next).
- The custom integration stays for Home Assistant installs that can't run
  add-ons (Container, Core); it and the box can't both feed the same entity
  without sending it twice.
- Switching devices (milestone C) will use the same link, in the other
  direction, and only when a person asks.
