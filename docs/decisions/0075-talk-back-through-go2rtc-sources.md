# 75. Talk-back through go2rtc's two-way audio sources

Date: 2026-11-04 · Status: accepted; extends ADR 0069 and 0074

## Context

Talk-back reaches an IP camera's speaker one way: its ONVIF RTSP
backchannel (ADR 0069 for typed speech, ADR 0074 for push-to-talk). Many
cameras with a speaker don't offer one: Tapo, Hikvision without ONVIF audio,
XMeye recorders, DoorBird, and cameras only reachable through their vendor's
cloud. go2rtc, which the box already uses as a library (MIT), speaks the
two-way audio of each of these as a "source": dialled by URL scheme, it
offers a sendonly audio media, takes a track (`AddTrack`) and sends the
packets written to it.

## Decision

**One adapter for all of them.** `bridge/internal/speak` routes by the URL's
scheme: `rtsp://` and `rtsps://` stay on the box's own backchannel session,
untouched; any other known scheme is dialled with go2rtc. The adapter
(`go2rtc.go`) finds the sendonly audio media, picks the codec it can make,
creates the receiver, calls `AddTrack`, runs the source's `Start` (when it
returns, the camera hung up) and writes 20 ms RTP packets at the pace they
are heard. Typed speech (`Play`), push-to-talk (`OpenLive`, the same `Write`
of 8 kHz samples the RTSP stream takes) and the probe go through it with no
caller-specific code.

**Codecs.** In this order: G.711 (µ-law or A-law) at 8 kHz, G.711 at another
rate, 16-bit PCM (big- or little-endian) at any rate, resampled with go2rtc's
`pcm` package (a message from its own rate, once; live audio from the 8 kHz
the Opus decoder gives). A speaker that takes Opus only (Ring, and WebRTC
sources whose answer offers nothing else) gets the person's Opus as it came,
for push-to-talk: no decoding, renumbered, on the browser's clock, the
camera's WebRTC stack doing the jitter buffering. Typed messages can't be
played to it: there is no Opus encoder in pure Go, and a cgo or GPL one isn't
taken; the box says so ("the camera's speaker takes Opus only: push-to-talk
works, typed messages can't be played on it yet") and its probe reports
`talk` without `speaker`. AAC and anything else is refused with the codec
named, as on the backchannel.

**Owning the teardown.** go2rtc's receiver isn't safe to write while it is
being closed, and several sources repack audio into larger packets (DVR-IP
40 ms, Tuya 30 ms, Xiaomi 40 ms) and hold a packet's remainder until more
comes. The adapter stops writing before it closes anything, ends every
session with 60 ms of silence at its pace (so the last words are flushed;
without it a 1.01 s message lost its last 10 ms on DVR-IP), waits 40 ms for
go2rtc's sender to hand the last packet on, then stops the source and waits
for its `Start` to return. go2rtc's ISAPI client raced (the audio connection
was set and read from two goroutines without a lock), dropped what was
written before the camera took the connection (a message's first words),
may be handed a pooled keep-alive connection, which leaves it unset, and
closed the connection with packets still queued: against the fake camera it
failed under the race detector. A fixed copy is kept in
`bridge/internal/third_party/go2rtc/isapi` (MIT notice kept, the changes
listed at its top); it says when it is `Ready`, which the adapter waits for
before the first packet. go2rtc's Tapo and DVR-IP clients are used as they
are.

| Scheme | Camera | Where | What the box sends | Tested |
|---|---|---|---|---|
| `tapo://`, `vigi://` | TP-Link Tapo, Vigi | local | A-law 8 kHz, in MPEG-TS over the camera's HTTP multipart session | fake camera (Digest, multipart, the MPEG-TS demuxed) |
| `isapi://` | Hikvision ISAPI | local | µ-law or A-law 8 kHz, as its TwoWayAudio channel lists, raw over `PUT …/audioData` | fake camera (Digest, close, open, audioData); fixed copy of go2rtc's client |
| `dvrip://` | XMeye / NetSurveillance (DVR-IP) | local | A-law 8 kHz in 40 ms `OPTalkData` packets | fake camera (login, OPTalk, the 8-byte audio headers); tail silence |
| `doorbird://` | DoorBird | local | µ-law 8 kHz, raw over `POST /bha-api/audio-transmit.cgi` | routing, unit |
| `multitrans://` | TP-Link (China) MULTITRANS | local | A-law 8 kHz RTP, interleaved | routing, unit |
| `ring:` | Ring | cloud | Opus 48 kHz, push-to-talk only | routing; the Opus path with a fake source |
| `roborock://` | Roborock | cloud | what the WebRTC answer offers: G.711 or PCM, else Opus (push-to-talk only) | routing, unit |
| `tuya://` | Tuya | cloud | likewise; go2rtc repacks G.711 into 30 ms packets | routing; the camera's audio is taken too (and dropped), as go2rtc's Tuya won't start receiving nothing |
| `wyze://` | Wyze | cloud keys | the codec the camera sends (G.711 or PCM; AAC refused) | routing, unit |
| `exec:` | any command (go2rtc's syntax, `#audio=pcma/8000`; default 16-bit little-endian, 16 kHz) | the box | raw audio on the command's stdin; stdin is closed at the end and the command given 2 s to finish | a real command (`tee`) |

Every source shares the codec negotiation, the pacing and the teardown tested
with fake go2rtc sources (16-bit PCM at 16 kHz, Opus, a source that is ready
late, a source that needs a receive track, one that hangs up, a dial that
outlives its context). The fake cameras' tests run under `go test -race
-count=20` for the teardown path: the whole message arrives (sample counts
compared, then only silence), no faster than it plays, and the session is
closed.

**Configuration.** A camera's speaker is its RTSP backchannel unless it has a
talk-back URL:
- `--talk CAMERA=URL` on the box (repeatable; `SENSEPLANE_TALK`, one per
  line), CAMERA being the camera's source ID or the host in its RTSP URL;
  it wins over the API's;
- `talk_url` on an rtsp source (`POST /v1/sources`, `PATCH
  /v1/sources/{id}`, `null` to go back), stored encrypted like `rtsp_url`,
  never returned (sources show `talk_url_set`), and sent only to the camera's
  bridge in its config. A changed URL is checked again without restarting
  the video.
Logs show a talk-back URL without its userinfo and with every query value
and fragment as `***`; errors from go2rtc are redacted the same way before
they are logged or reported (a URL parse error would otherwise echo the
URL).

**Commands only from the box.** `exec:` runs a program, so only whoever runs
the box may set one: the API's `talk_url` refuses it (its pattern lists the
go2rtc schemes and `rtsp`), and the box ignores a `talk_url` with `exec:` or
a scheme it doesn't know, logging only the scheme, and uses the RTSP
backchannel.

**Cloud sources.** Ring, Roborock, Tuya and Wyze URLs carry an account's
tokens or keys (what go2rtc's own setup pages produce); they are supported
as talk-back only, treated as secrets like an RTSP password, and the audio
goes through the vendor's service. Their video is not taken: the box still
relays only RTSP.

**Capability.** The probe dials the source, looks for the sendonly audio
media and closes it, without starting a talk session (no Tapo talk request,
no DVR-IP `OPTalk`, no ISAPI `open`; DoorBird's and MULTITRANS's dial already
opens their audio channel, which is closed again unused). The box reports
`speaker` (messages can be played) and `talk` (push-to-talk) from it, as the
migration 0057 capability expects.

## Consequences

- New dependencies, through go2rtc's packages: Eclipse Paho MQTT for Go
  (Tuya; dual EPL-2.0 or EDL-1.0, taken under EDL-1.0, the BSD 3-Clause
  licence, noted in the CI licence review) and `golang.org/x/sync` (BSD).
  The others (Pion, gorilla/websocket, google/uuid, sigurn's CRCs) were
  already there.
- Needs real hardware: every vendor's quirks (firmware that wants another
  codec, Tapo firmware whose own audio is µ-law at 16 kHz while go2rtc
  sends it A-law at 8 kHz, cloud sessions'
  limits), echo, and how much each camera buffers.
- Not taken: Xiaomi (go2rtc mints a fresh device URL per session through its
  cloud login, which lives in go2rtc's internal packages the box can't
  import; a saved URL goes stale), go2rtc's generic `webrtc:` client and
  local sinks (ALSA, Wyoming), which aren't camera speakers. Typed messages
  to Opus-only speakers wait for a pure-Go Opus encoder.
