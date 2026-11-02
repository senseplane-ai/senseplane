# 63. Cameras found by the box: ONVIF discovery and Home Assistant's camera list

Date: 2026-11-02 · Status: accepted

## Context

A box (the bridge as a Home Assistant add-on, or the bridge container)
relays IP cameras, but each one had to be added with its RTSP address
(ADR 0061). Few people know it: it is buried in the camera's manual, differs
per maker, needs the camera account's password inside it, and the main
stream is often larger than the plan's `max_resolution`, so the media plane
refuses it. Nearly every IP camera speaks ONVIF, which can be found on the
local network and asked for its streams, and a home with Home Assistant
already has its cameras named and in rooms.

## Decision

**The box looks for cameras.** The bridge sends WS-Discovery probes
(`239.255.255.250:3702`, typed `dn:NetworkVideoTransmitter` and untyped,
for the cameras that only answer that) when it starts, every 5 minutes and
when a person presses "Look again" (`onvif_search`). Answers that aren't
ONVIF devices (printers, PCs) are left out. Each camera's maker and model
come from `GetDeviceInformation` when it answers without credentials, else
from the probe's scopes. A camera missed by three searches drops off. The
list goes to the API (`PUT /v1/bridge/cameras-found`: endpoint id, address,
device service URL, maker, model) whenever it changes; it never carries
credentials. Health reports say how many are listed (`cameras_found`), and
the console shows "Found on your network" only on boxes that look.

**Named after Home Assistant's.** With Home Assistant, the bridge also reads
its `camera.*` entities with their room and device (maker, model,
`configuration_url`, `connections`) from the registries it already reads.
An entity whose device URL has the camera's address, or whose MAC matches a
MAC in the camera's scopes, names it: "Front door (Kitchen) · Tapo C200 at
192.168.1.40". Home Assistant cameras that match none are listed too, to
add with their RTSP address.

**Adding one.** A person picks a camera and enters its username and
password (`POST /v1/bridges/{id}/onvif`, admins). The API checks the source
limit, then hands the box an `onvif_add_camera` command through the command
channel (ADR 0062) with the device service URL, the credentials, a name (the
Home Assistant name, else the model) and the plan's `max_resolution`; the
arguments are sealed with `SECRETS_ENCRYPTION_KEY` and cleared once the box
takes them, so the API never needs to reach the camera. The box asks the
camera for its media service (`GetCapabilities`), its profiles
(`GetProfiles`) and the stream URI of the one it picks (`GetStreamUri`),
signing each request with a WS-UsernameToken digest timed by the camera's
own clock (`GetSystemDateAndTime`; many were never set), and with HTTP
digest when the camera asks for it. It picks the largest H.264 profile
within `max_resolution` as the media plane checks it (long and short side):
usually the main stream on 1080p and the substream on 720p. Nothing is
transcoded, so a camera with no H.264 stream, or whose H.264 streams are all
larger, gets an error in words ("turn on a smaller substream"). The box then
adds the camera exactly as `--rtsp` does (`POST /v1/bridge/cameras`, the
credentials in the RTSP URL, stored encrypted), fetches its config at once
and starts relaying; the command's result names the new source and the
profile. A wrong password comes back as "the camera refused the username or
password". Passwords never appear in logs, results or errors (the API also
removes credentials from reported errors).

The SOAP client is hand-written (a few hundred lines with discovery), with no
new dependency. go2rtc's ONVIF package (already in the module) covers part
of it, but takes the credentials in a URL, returns raw XML, and has no
endpoint ids, MAC scopes, camera-clock timing or HTTP digest.

**Host networking.** Cameras answer a probe on the sender's own address, so
the bridge must be on the home network itself: the add-on runs with
`host_network: true`, and the container with `--network host` (Linux).
With host networking the add-on's panel would listen on the home network
too, and it shows the pairing code, so as an add-on it answers only the
Supervisor's network (ingress and the watchdog) and the box itself. The
bridge still opens no port to the internet. `--find-cameras=false` turns
discovery off.

**No relay of Home Assistant's own stream.** Relaying the stream Home
Assistant shows was the fallback for cameras without ONVIF, and was left out:

- `camera/stream` returns an HLS playlist of fragmented MP4 segments (Home
  Assistant's stream integration), and go2rtc's HLS reader takes MPEG-TS
  only; reading fMP4 would be a second media path to keep.
- That HLS exists only for cameras whose RTSP stream Home Assistant pulls
  itself, which the box can usually reach directly anyway. Cloud cameras
  (Nest and the like), the case the fallback was for, are WebRTC-only in
  Home Assistant, and go2rtc 1.9.14's Home Assistant client predates the
  current WebRTC offer API (a subscription with trickled candidates).
- It would add seconds of latency and stop with every Home Assistant
  restart.

A WebRTC client for Home Assistant's current API (receiving the H.264 track
with pion, which the bridge already uses, and pushing it as WHIP) is the way
to add cloud cameras later.

## Consequences

- Tested against a fake camera (a WS-Discovery responder on a local UDP
  socket and the device and media services, which check the digest, a skewed
  clock and HTTP digest), the command flow through a fake API, and Home
  Assistant's camera list against the fake Home Assistant; real cameras are
  the acceptance test.
- Discovery finds nothing from Docker Desktop on macOS or Windows (its VM
  can't see the home network); cameras there are added by address.
- Cameras on another subnet or VLAN aren't found (multicast doesn't cross
  routers); they are added by address.
- Some cameras need ONVIF turned on first (a Tapo needs a camera account
  made in its app); the console says so when nothing is found.
- The RTSP URL is the camera's own; if the camera's address changes
  (DHCP), the camera is added again from the list, as one added by address
  would be edited.
