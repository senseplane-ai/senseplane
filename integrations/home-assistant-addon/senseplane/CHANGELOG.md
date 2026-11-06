# Changelog

## 0.2.4

- Talk-back through more cameras (Tapo, Hikvision, DVR-IP, DoorBird and others), Matter pairing
  over Bluetooth, Shelly BLU sensors.

- MQTT (off until turned on): publishes Senseplane's events to Home Assistant
  through MQTT discovery, so a "Person" sensor for each camera, its online
  state and an event for each watch appear by themselves. Uses the Mosquitto
  add-on, or a broker you set. Plain MQTT topics can be read as sensors too.

## Earlier

- First release: reads Home Assistant's sensors (doors, windows, motion, leaks,
  smoke, plugs, lights, locks, doorbells, buttons, temperatures and other
  numbers) and sends the ones you choose; relays IP cameras; pairs with a code.
- Finds ONVIF cameras on your network, named after Home Assistant's, to add
  with their username and password instead of an RTSP address (runs on the
  host network for this).
