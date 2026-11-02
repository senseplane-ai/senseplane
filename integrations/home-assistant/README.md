# Senseplane for Home Assistant

Sends Home Assistant sensors to a Senseplane sensor source: temperatures and
other numbers, door, window and motion sensors, leaks and smoke, plugs,
lights and locks, doorbells and buttons. Agents can read them
(`read_environment`), ask about them ("how many times was the fridge opened
today?") and watch them ("tell me if the garage door is left open for 10
minutes" fires a `reading.threshold` event).

It only sends: Senseplane never connects to Home Assistant.

## Install

Copy `custom_components/senseplane` into your Home Assistant `config/custom_components/`
folder and restart Home Assistant. (`hacs.json` is included for a HACS custom
repository that holds this folder at its root.)

## Set up

1. In Senseplane, add a source of type **Home Assistant sensors** (`type: "sensor"`).
   Copy the access token it shows once (`sit_…`). Lost it? Rotate it with
   `POST /v1/sources/{id}/ingest-token`.
2. In Home Assistant: **Settings → Devices & services → Add integration → Senseplane**.
3. Enter the Senseplane API URL (for example `https://senseplane.example.com`) and the token.
4. Pick the entities to send. Change them later under **Configure**.

Each Senseplane sensor source is one entry; add the integration again for
another room.

## What is sent

- Every state change of the chosen entities, plus each current value at
  start-up (except an event entity's last event, which came before).
- Each reading names its entity as the device (`binary_sensor.fridge`, "Fridge
  door"), so one source can hold several doors or plugs.

| Home Assistant | Senseplane |
|---|---|
| `sensor` with a device class: temperature, humidity, power, energy, voltage, current, illuminance, carbon dioxide, PM2.5, pressure, battery, sound pressure | A number in Senseplane's unit (°F and K become °C, kW becomes W, Wh becomes kWh, inHg becomes hPa) |
| `binary_sensor`: door, window, garage door, opening | `contact` (on = open) |
| `binary_sensor`: motion, occupancy, presence, moisture, smoke, carbon monoxide, gas, lock, vibration, tamper | `motion`, `occupancy`, `leak`, `smoke`, `carbon_monoxide`, `gas`, `lock`, `vibration`, `tamper` |
| `switch`, `light`, `fan`, `input_boolean`, `siren` | `switch` (on/off) |
| `lock` | `lock` (true = unlocked) |
| `event`: doorbell, button | `doorbell`, `button` (with the press type, such as `double`) |

- `unknown`, `unavailable`, unsupported device classes and units are skipped.
- Readings are batched (every 10 s, or 500 at once). While Senseplane is
  unreachable they are kept (up to 5,000, oldest dropped first) and retried
  with backoff from 2 s up to 5 min.
- If Senseplane refuses the token (rotated or revoked), sending stops and Home
  Assistant asks for the new token.

The token can only push readings to its own source and read that source; it
cannot see cameras or anything else in the account.

## Develop

The API client and forwarder are plain Python and tested without Home Assistant:

```sh
uv run pytest
```
