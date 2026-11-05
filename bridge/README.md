# bridge

Relays RTSP cameras on a local network to Senseplane, and sends the Home
Assistant sensors a person chose, outbound only: no inbound ports, no port
forwarding (ADR 0045, 0061).

- Fetches the cameras assigned to its token from the API (`GET /v1/bridge/config`, every 60 s).
- Pulls each camera with go2rtc's RTSP client (MIT, used as a library) and
  pushes the same H.264 over WHIP (`internal/whip`); nothing is re-encoded.
- Reconnects with backoff (1 s doubling to 30 s) when the camera or the media
  connection drops, or the camera sends nothing for 10 s.
- Reports each camera's state (`connecting`, `online`, `reconnecting`,
  `offline`) every 30 s and on every change; the console shows it on the source.

## Run

Create a source with `"type":"rtsp"` (the console's "IP camera"); it returns a
bridge token and this command:

```sh
docker run -d --restart unless-stopped --name senseplane-bridge ghcr.io/senseplane-ai/bridge:0.2 \
  --api https://senseplane.example.com --token brg_… --rtsp rtsp://user:pass@192.168.1.40:554/stream1
```

`--rtsp` claims the camera the token was created for; more `--rtsp` flags (or
sources created with `"bridge_id"`) add cameras to the same bridge.

| Flag | Environment | Purpose |
|---|---|---|
| `--api` | `SENSEPLANE_API_URL` | Your Senseplane API URL |
| `--token` | `SENSEPLANE_BRIDGE_TOKEN` | Bridge token (`brg_…`) |
| `--rtsp` (repeatable) | `SENSEPLANE_RTSP` (comma-separated) | Camera URLs to claim or add |
| `--name` | | Name for a camera added with `--rtsp` |
| `--talk` (repeatable) | `SENSEPLANE_TALK` (one per line) | `CAMERA=URL`: reach a camera's speaker through one of go2rtc's two-way audio sources or a command instead of its RTSP backchannel ([Talk-back](#talk-back)) |
| `--whip-base` | `SENSEPLANE_WHIP_BASE` | Push to the media plane at this base URL instead of the public one |
| `--listen` | `BRIDGE_LISTEN` | The status page, `/healthz` and `/metrics` (default `127.0.0.1:8099`) |
| `--ha-url` | `HA_URL` | Read sensors from this Home Assistant (`http://homeassistant.local:8123`); as an add-on the Supervisor's is used |
| `--ha-token` | `HA_TOKEN` | A Home Assistant long-lived access token |
| `--state-dir` | `SENSEPLANE_STATE_DIR` | Without `--token`: pair with a code and keep the token here |
| `--box-name` | `SENSEPLANE_BOX_NAME` | The name a person sees when pairing (default `Home Assistant`) |
| `--matter-url` | `MATTER_URL` | Read Matter devices through this Matter Server (`ws://localhost:5580/ws`) |
| `--find-cameras` | `SENSEPLANE_FIND_CAMERAS` | Look for ONVIF cameras on the network to pick in the console (default on; `false` turns it off) |
| `--mqtt-url` | `MQTT_URL` | Read sensors from, and publish events to, this MQTT broker (`mqtt://`, `mqtts://`, `ws://`, `wss://`); off when empty |
| `--mqtt-username`, `--mqtt-password` | `MQTT_USERNAME`, `MQTT_PASSWORD` | The broker's credentials; prefer the environment for the password, since flags show in process lists |
| `--mqtt-topic` (repeatable) | `MQTT_TOPICS` (comma-separated) | A plain topic to read, `TOPIC=SENSE[:UNIT][@JSON.PATH]` |
| `--mqtt-discovery-prefix` | `MQTT_DISCOVERY_PREFIX` | Home Assistant's discovery prefix (default `homeassistant`) |
| `--mqtt-prefix` | `MQTT_PREFIX` | Where the box publishes its own states (default `senseplane`) |

Passwords in RTSP URLs never appear in logs or in what the bridge reports.

## Talk-back

The bridge plays agents' messages (ADR 0069) and carries a person's
push-to-talk (ADR 0074) to a camera's speaker. By default that is the
camera's ONVIF RTSP backchannel (G.711). A camera without one can be given a
talk-back URL, one of go2rtc's two-way audio sources (ADR 0075):

| URL | Camera | Where | Audio |
|---|---|---|---|
| `tapo://CLOUD_PASSWORD@IP`, `tapo://admin:HASH@IP`, `vigi://admin:PASSWORD@IP` | TP-Link Tapo, Vigi | local | A-law 8 kHz |
| `isapi://USER:PASSWORD@IP` | Hikvision | local | µ-law or A-law 8 kHz |
| `dvrip://USER:PASSWORD@IP` | XMeye / NetSurveillance recorders and cameras | local | A-law 8 kHz |
| `doorbird://USER:PASSWORD@IP` | DoorBird | local | µ-law 8 kHz |
| `multitrans://USER:PASSWORD@IP:554` | TP-Link (China) | local | A-law 8 kHz |
| `ring:?refresh_token=…&camera_id=…&device_id=…` | Ring | cloud | Opus: push-to-talk only |
| `roborock://…`, `tuya://…`, `wyze://…` | Roborock, Tuya, Wyze | cloud | G.711 or PCM; Opus for push-to-talk only |
| `exec:COMMAND#audio=pcma/8000` | anything a command can reach | the box | the format `#audio=` names (default 16-bit little-endian, 16 kHz) on the command's stdin |

The URLs are go2rtc's own (its setup pages for Ring, Roborock, Tuya and Wyze
produce them); cloud URLs carry the account's tokens and the audio goes
through the vendor's service. Only talk-back is taken from cloud cameras, no
video. Give a camera its URL either way:

- on the box: `--talk CAMERA=URL`, CAMERA being the camera's source ID or the
  host in its RTSP URL, e.g. `--talk 192.168.1.40=tapo://cloudpass@192.168.1.40`;
- in the API: `talk_url` on the source (`PATCH /v1/sources/{id}`, `null` to
  go back to the backchannel). It is stored encrypted like the RTSP URL, sent
  only to the camera's bridge, and never shown again (the source says
  `talk_url_set`).

A command (`exec:`) can only be set on the box: the API refuses one, and the
bridge ignores one that comes from it. The box's flag wins over the API's
URL. The bridge checks each speaker without playing anything and reports
whether it takes messages (`speaker`) and push-to-talk (`talk`); a speaker
that takes Opus only (Ring) takes push-to-talk, as the person's Opus is passed
on, but not typed messages, which the box can't encode to Opus. Talk-back URLs
are logged without their passwords and query values.

## Home Assistant

With `--ha-url` and `--ha-token` (or as the Home Assistant add-on), the bridge
reads Home Assistant's websocket API: it lists the entities Senseplane can
take (numbers such as temperature and power, door, motion and leak sensors,
switches, lights and locks, covers, alarm panels and thermostat settings,
doorbells and buttons; `spec/home-assistant/readings.json`) with their room,
and sends readings only of the ones a person chose in the console. It calls a
Home Assistant service only for a `device_control` command a person asked for
(turn a light on, lock a door; ADR 0067), on a device it lists with that
action; water heaters and anything heating or cooking are never switched.
Matter devices are switched the same way, through the Matter Server or the
built-in controller.

## MQTT

With `--mqtt-url` (or the add-on's `mqtt` option, which uses the Mosquitto
add-on through the Supervisor), the bridge connects to an MQTT broker
(ADR 0071; the client is `github.com/at-wat/mqtt-go`, Apache-2.0):

- **In.** It reads Home Assistant MQTT discovery
  (`homeassistant/<component>/[<node>/]<object>/config`, as ESPHome, Tasmota,
  Zigbee2MQTT and Shelly send it) for sensors, binary sensors, switches,
  lights, fans, locks, covers, alarm panels and events, maps their states by
  the same rules as Home Assistant's entities, and lists them to choose in the
  console (`mqtt.<component>_<id>`). A `value_template` is read only as a JSON
  path (`{{ value_json.a.b }}`, with `float`, `int`, `round(n)`, `lower`,
  `upper`, `trim`); nothing is executed. `--mqtt-topic` adds devices without
  discovery: `tele/plug/SENSOR=power:watt@ENERGY.Power` (a number in a
  Senseplane unit), `garage/door=contact` (on/off, true/false, 1/0, and the
  sense's own words: open/closed for a contact, wet/dry for a leak,
  locked/unlocked for a lock), `bell/press=doorbell` (an event on ON, press,
  pressed, 1 or true; `bell/state=doorbell:RING` fires on RING only). Messages
  over 64 KiB and entities past 2,000 are ignored. Only chosen ones are sent. As
  an add-on, discovered sensors aren't listed unless `mqtt_sensors` is on,
  since Home Assistant already lists them.
- **Out.** When **Publish to MQTT** is on for the box in the console (off by
  default), it long-polls `GET /v1/bridge/outputs` and publishes, retained,
  in Home Assistant's discovery format: per camera Person, Vehicle and Animal
  binary sensors (on for a minute after one is seen) and Online; per watch an
  event entity fired with the event's summary (firings more than 5 minutes
  old aren't sent; a few wait while the broker is away). Topics are named
  after the box, with ids in lowercase base32:
  `homeassistant/binary_sensor/senseplane_<box>_<camera>/person/config`,
  states under `senseplane/<box>/camera/<camera>/`, and
  `senseplane/<box>/status` (online, or offline as the will). Turned off, it
  removes what it published, never another box's. The hold is timed by each
  event's age on the server's clock, not the box's.

It reconnects with backoff (1 s to 1 min) and subscribes and publishes again
on every connection and when Home Assistant restarts (`homeassistant/status`).
A publish or subscribe that gets no answer in 5 s drops the connection. The
broker URL is checked once at start-up and never logged with its password;
credentials are sent apart from it.

## Cameras on the network

The bridge looks for ONVIF cameras on its network (WS-Discovery: a probe to
`239.255.255.250:3702` every 5 minutes, and when someone presses "Look
again") and lists them with the API, with their maker and model
(`GetDeviceInformation` when the camera answers it without credentials, else
the probe's scopes). With Home Assistant, each is named after the camera
entity on the same address or MAC (device registry `configuration_url` and
`connections`), with its room; Home Assistant cameras without a match are
listed too, to add by address. A person picks one in the console and enters
its username and password; they reach the bridge sealed through the command
channel (`onvif_add_camera`), and the bridge asks the camera for its profiles
and stream URI (WS-UsernameToken digest, HTTP digest if the camera wants it),
takes the largest H.264 profile within the plan's `max_resolution` (usually
the substream on 720p) and adds it like `--rtsp`. Nothing is transcoded
(ADR 0063).

Cameras answer the probe on the bridge's own address, so the bridge must be
on the home network itself: the add-on runs with host networking, and the
container needs `--network host` (Linux; Docker Desktop's VM network can't
see the home network, so there `--find-cameras` finds nothing and cameras are
added by address):

```sh
docker run -d --restart unless-stopped --name senseplane-bridge --network host -v senseplane-bridge:/data \
  ghcr.io/senseplane-ai/bridge:0.2 --api https://senseplane.example.com --state-dir /data --listen 127.0.0.1:8099
```

## Matter

With `--matter-url`, the bridge reads Matter devices through a Matter Server
(matterjs-server or python-matter-server, the WebSocket API Home Assistant's
Matter integration uses; run it with host networking). A person adds a device
on the box's page in Senseplane with the code they get by sharing it from its
own app (Apple Home, Google Home, the maker's app); the box commissions it and
its sensors are listed to choose from, like Home Assistant's. The bridge never
sends a device command (ADR 0062).

`MATTER_URL=ws://127.0.0.1:5580/ws go test -run Live ./internal/matter/`
checks the client against a real server and a device in pairing mode (the
matter.js example plug, `matter-device --type=socket`, code 34970112332).

## Pairing with a code

Without `--token`, give it `--state-dir`: the bridge asks Senseplane for a
code, shows it on its status page (`--listen`) and in its log, and waits
while someone enters it in the console (`/link`). It keeps the token it gets
in the state directory (mode 0600) and pairs again only if that token is
refused.

```sh
docker run -d --restart unless-stopped --name senseplane-bridge -v senseplane-bridge:/data -p 127.0.0.1:8099:8099 \
  ghcr.io/senseplane-ai/bridge:0.2 --api https://senseplane.example.com --state-dir /data --listen :8099 \
  --ha-url http://homeassistant.local:8123 --ha-token "$HA_TOKEN"
# open http://localhost:8099 for the code
```

## Build and test

```sh
go test ./... && go build -o bin/bridge ./cmd/bridge
docker build -t ghcr.io/senseplane-ai/bridge:dev .   # static binary on distroless, runs as nonroot
```

Layout: `internal/api` (the bridge's API client), `internal/bridge` (config
polling, one relay per camera, health reports, the Home Assistant link),
`internal/relay` (pull → push with reconnects), `internal/camera` (go2rtc
RTSP → Annex B access units with exact durations), `internal/whip` (WHIP
client), `internal/homeassistant` (websocket client and state → reading
mapping), `internal/sensors` (batched sending with backoff),
`internal/pairing` (codes and the state file), `internal/matter` (a Matter
Server client and the attribute → reading mapping), `internal/onvif`
(WS-Discovery and the device and media calls; `onviftest` is a fake camera
for tests), `internal/speak` (talk-back: the RTSP backchannel and go2rtc's
two-way audio sources; `internal/third_party/go2rtc` is a fixed copy of
go2rtc's ISAPI client, MIT), `internal/talk` (push-to-talk), `internal/health`.

## WHIP client

`internal/whip` pushes an H.264 stream to a WHIP endpoint (RFC 9725) without
re-encoding (pion/webrtc, MIT). The bridge uses it to relay the cameras that
go2rtc pulls, because go2rtc's own `publish:` only supports RTMP (ADR 0034).
`cmd/whip-push` is a dev tool over it:

```sh
go build -o bin/whip-push ./cmd/whip-push
ffmpeg -rtsp_transport tcp -i rtsp://camera/stream -an -c copy -bsf:v dump_extra -f h264 - \
  | WHIP_TOKEN=... bin/whip-push -endpoint https://media.example/whip/src_123 -fps 15
```
