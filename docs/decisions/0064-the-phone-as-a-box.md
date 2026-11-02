# 64. The phone as a box: the Android app runs the bridge

Date: 2026-11-02 · Status: accepted

## Context

A phone can already stream from the capture page (milestone 1), but only
while the page is open and the screen on. People also asked to use an old
Android phone at home as the box: to send its own camera, relay the IP
cameras on its Wi-Fi (ADR 0063) and listen for Bluetooth sensors, without a
Home Assistant install or a computer running the bridge container. Writing
all of that again in Kotlin would mean two bridges to keep in step.

## Decision

**One bridge.** The Go bridge is built into the app with gomobile
(`bridge/mobile`, `android/build-bridge.sh`) as a library. The app is a
box like the add-on or the container: it pairs with a code (ADR 0061), gets
its own bridge token, relays IP cameras, lists the cameras it finds and
lists and sends sensors through the same API. Nothing on the server knows
it is a phone, except the name a person gives it.

**Its own camera is a relayed camera.** The phone's back camera is encoded
by MediaCodec (H.264, 720p, 15 fps, about 2 Mbit/s; 720p is the lowest
`max_resolution` a plan has, so every plan takes it, and it keeps the phone cool) and handed to the bridge frame by frame (`PushFrame`),
with SPS/PPS before each keyframe. The bridge adds it as one of its cameras
with the address `rtsp://this-phone.senseplane.invalid/camera` (a reserved
name that nothing resolves) and sends it over WHIP like any other camera,
so recording, watches and playback are unchanged. When the phone's camera
stops, the bridge marks the source reconnecting, then offline.

**Sensors on the phone.** The phone offers its battery level, charging
state, light level and motion (a jolt is motion; 30 s of stillness ends it)
as sensors of its box, and the BTHome v2 Bluetooth sensors it hears
(`bridge/internal/bthome`, unencrypted ones; service data `0xFCD2`). As with
Home Assistant, nothing is sent until a person turns a sensor on, here in
the app itself (`POST /v1/bridge/entities/choose` with the box's token) or
in the console.

**Runs in the background.** A foreground service with a notification keeps
the box running with the screen off or dimmed, with a wake lock and a
multicast lock (for ONVIF discovery). It asks only for the permissions of
what the phone does: camera, notifications, and Bluetooth scan with
`neverForLocation`.

**Managing from the phone.** Owners and admins can sign in to chat, see
activity, list cameras and set watches, using the same public API as the
console. The camera and sensors keep working without signing in.

**Not on the phone.** A phone is not a Matter controller here: the app
points to the box with Home Assistant or the bridge container for Matter
(ADR 0062). Encrypted BTHome sensors aren't read yet.

## Consequences

- Fixes and features in the bridge reach the add-on, the container and the
  phone together; the app is a UI and a camera and sensor feed around it.
- The debug APK carries the Go library for arm64 and x86_64 (about 109 MB);
  release builds split by ABI.
- Tested end to end on an emulator against a running stack
  (`PhoneBoxE2ETest`): pair, camera online and recording, a sensor chosen in
  the app and its reading arriving.
