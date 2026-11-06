# Changelog

## 0.2.6

- Camera sound: the box now sends a camera's sound when it is G.711 (most
  cameras, such as Galayou and Tapo), so Listen and sound watches work on box
  cameras. Turn on "Record audio" for the camera in Senseplane. Cameras that
  send AAC sound still stream their picture only, and Listen now says so
  instead of reporting "no sounds detected".

## 0.2.5

- Cameras that send 2K or 3 MP (above the server's limit) are no longer
  reconnected in a loop: the box reads the picture size first, and the
  camera's page in Senseplane says the size and the limit. Servers can now
  record up to 1440p.

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
