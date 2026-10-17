# Senseplane for Home Assistant

Sends Home Assistant temperature and humidity sensors to a Senseplane sensor
source, so agents can read them (`read_environment`) and watches can act on
them ("Warn me if the server room gets hot" fires a `reading.threshold` event).

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
4. Pick the temperature and humidity sensors to send. Change them later under **Configure**.

Each Senseplane sensor source is one entry; add the integration again for
another room.

## What is sent

- Every state change of the chosen sensors, plus each current value at start-up.
- Temperatures in °C (°F and K are converted); humidity in %.
- `unknown`, `unavailable` and non-numeric states are skipped.
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
