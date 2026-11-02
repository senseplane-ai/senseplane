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

To add an IP camera through this box, open the box in Senseplane (**Cameras
→** your box) and add the camera's RTSP address; the add-on pulls the stream
on your network and sends it on, without re-encoding it.

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

## Options

| Option | |
|---|---|
| `server` | Your Senseplane address (required) |
| `name` | What you see in Senseplane when you connect the box (default: Home Assistant) |

## When something is wrong

- **The panel shows no code:** the add-on can't reach the server. Check the
  address and the add-on's log.
- **"Can't reach Home Assistant" in Senseplane:** restart the add-on.
- **The box was removed in Senseplane:** the add-on notices and shows a new
  code; connect it again.

The add-on keeps its connection to Senseplane in its own storage. Removing
the add-on removes it; the box then disappears from Senseplane once you
delete it there.
