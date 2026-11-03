# Senseplane

Senseplane gives AI agents (Claude, ChatGPT, your own code) eyes and ears:
they can ask "has the fridge been opened today?", watch for "the garage door
is left open for 10 minutes", and look at your cameras. This add-on is how a
home with Home Assistant connects: it sends the sensors you choose, and relays
IP cameras on your network. It only connects outwards; nothing on the
internet reaches into your home.

## Set up

1. Set **Server** to your Senseplane address (for example
   `https://senseplane.example.com`) and start the add-on.
2. Open the add-on's panel (**Senseplane** in the sidebar). It shows a code
   such as `BCDF-GHJK`.
3. In Senseplane, open **Cameras → Add camera → Home Assistant → Enter the
   code** (or follow the link in the panel), sign in and connect the box.
4. Choose the sensors Senseplane gets. Nothing is sent until you do, and you
   can change it any time. Each room's sensors appear in Senseplane as one
   sensor, named after the room in Home Assistant.

## Cameras

Open the box in Senseplane (**Cameras →** your box). Under **Found on your
network** it lists the IP cameras it found on your network (cameras with
ONVIF, which most have; on some, such as Tapo, turn it on by creating a camera
account in the camera's app), named after the same camera in Home Assistant
when there is one: "Front door (Kitchen) · Tapo C200 at 192.168.1.40". Choose
**Add**, enter the camera's username and password, and the add-on asks the
camera for its stream and starts sending it. It picks the stream that fits
your plan (often the camera's smaller second stream) and never re-encodes it.
The password goes to the add-on only and is stored encrypted.

A camera that isn't listed (no ONVIF, or a cloud camera that only Home
Assistant can show) can still be added with its RTSP address on the same page.

The add-on runs on the host network so it can find cameras: the search is a
message every camera on the network hears, and they answer the add-on
directly. Its panel still opens only from Home Assistant.

## What is sent

Only the entities you choose, whenever their state changes:

| In Home Assistant | In Senseplane |
|---|---|
| Door, window and garage door sensors | open or closed |
| Motion, occupancy, leak, smoke, carbon monoxide, gas, vibration, tamper sensors | their state |
| Switches, plugs, lights, fans | on or off |
| Locks | locked or unlocked |
| Doorbell and button events | each press |
| Temperature, humidity, power, energy, voltage, current, light level, CO2, PM2.5, pressure, battery, sound level | the value, in metric units |

The add-on reads Home Assistant; it never switches anything.

## MQTT

With the Mosquitto add-on (or another broker), the add-on can publish what
Senseplane sees back into Home Assistant, without any setup there. Turn on
**MQTT** here, then in Senseplane open the box and turn on **Publish to
MQTT** (both are off until you do). Home Assistant then shows, through MQTT
discovery:

- for each camera, a device with **Person**, **Vehicle** and **Animal**
  sensors (on for a minute after one is seen) and **Online**;
- **Senseplane watches**, with an event each time a watch fires, to start
  automations from.

The add-on finds the Mosquitto add-on by itself; set **MQTT broker**, with a
username and password, for another one. It connects to the broker; nothing
connects to it.

Sensors that MQTT discovery announces are already in Home Assistant, so the
add-on reads them from there. A device that only publishes to a topic, with no
discovery, can be read as a sensor with **Plain MQTT topics**:
`tele/plug/SENSOR=power:watt@ENERGY.Power` reads `ENERGY.Power` from the JSON
on `tele/plug/SENSOR` as power in watts; `garage/door=contact` reads `open`,
`closed`, `ON`, `OFF`, `true` or `false`. Units are Senseplane's: celsius,
percent, watt, kilowatt_hour, volt, ampere, lux, ppm and the rest.

## Options

| Option | |
|---|---|
| `server` | Your Senseplane address (required) |
| `name` | What you see in Senseplane when you connect the box (default: Home Assistant) |
| `mqtt` | Publish Senseplane's events to MQTT (off; also turn it on for the box in Senseplane) |
| `mqtt_url`, `mqtt_username`, `mqtt_password` | Another broker than the Mosquitto add-on |
| `mqtt_discovery_prefix` | Home Assistant's discovery prefix (default: homeassistant) |
| `mqtt_sensors` | Also list the sensors MQTT discovery announces (off: Home Assistant lists them) |
| `mqtt_topics` | Plain topics to read as sensors, `TOPIC=SENSE[:UNIT][@JSON.PATH]` |

## When something is wrong

- **The panel shows no code:** the add-on can't reach the server. Check the
  address and the add-on's log.
- **"Can't reach Home Assistant" in Senseplane:** restart the add-on.
- **The box was removed in Senseplane:** the add-on notices and shows a new
  code; connect it again.

The add-on keeps its connection to Senseplane in its own storage. Removing
the add-on removes it; the box then disappears from Senseplane once you
delete it there.
