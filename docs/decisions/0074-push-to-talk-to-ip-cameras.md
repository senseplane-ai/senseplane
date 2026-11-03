# 74. Push-to-talk to IP cameras

Date: 2026-11-03 · Status: accepted; extends ADR 0069

## Context

Talk-back (ADR 0069) has two ways to speak. Typed speech reaches every
camera with a speaker: the phone plays the clip, or the box plays it to an IP
camera over its ONVIF RTSP backchannel. Live push-to-talk reached phones
only: the console's microphone is a `talkback` track on the media plane that
only `{source_id}:capture` may receive. A box only makes outbound
connections, behind the home's NAT, and only ever fetched finished clips. Most
cameras with a speaker are IP cameras: a doorbell is where people most want
to answer.

## Decision

**The box pulls the press.** A press is still one `talkback` track from the
console; the media plane decides who may receive it, as before.

- For an IP camera, the viewer's live token names the box's listener,
  `{source_id}:speaker`, in `visibleTo` instead of the phone. Nobody else in
  the room (other viewers, the recorder, agents, the phone path) receives
  it.
- When the media plane's `producer.added` callback says a viewer started
  talking on a camera behind a box, the API queues a `talk` command for that
  camera's box (the command channel of ADR 0062, taken within 10 s and with a
  `run_by`, or never). Its arguments, sealed like every command's and
  cleared once taken, are the media plane's WHEP URL
  (`{MEDIA_PUBLIC_URL}/whep/talkback`), the press's producer and a join token
  for that one press: identity `{source_id}:speaker`, kind `agent`, audio in
  only (`canPublish: false`, `subscribeKinds: ["audio"]`,
  `maxSubscriptions: 1`, `listenTo: <the press's producer>`), single use,
  expiring with the press's cap.
- **Each press is its own track.** The media plane gives a listener only the
  producer its token names, and only while that press is held; a token for
  an earlier press (a box slow to connect while the person let go and
  pressed again) gets 404 and never hears, nor ends, the later one. A
  listener that goes away ends only the press it had; the API's
  `talkback/stop` names the producer too.
- The box pulls the press first, with a WHEP-style request
  (`spec/media/whep.md`): an SDP offer POSTed with the token, an ICE-lite
  answer back, `DELETE` to end. WebRTC is Pion (MIT), which the box already
  uses for WHIP. Only then does it take the camera's speaker and open its
  backchannel (`DESCRIBE`, `SETUP`, `PLAY`, as for clips), so a command for a
  press already over never opens the speaker. The media plane answers 404
  `no_talkback` when nobody is talking, the talker didn't name this
  listener, or the token is for another press, so a token for another
  camera, or a talker on the phone path, gets nothing.
- The backchannel is kept alive while a press lasts: the box sends
  `GET_PARAMETER` (`OPTIONS` to a camera that refuses it) every half of the
  session timeout the camera's `SETUP` names, since interleaved audio isn't a
  request and cameras drop sessions that send none.

**Audio.** The box decodes Opus in pure Go with Pion's decoder
(`github.com/pion/opus`, MIT, SILK, CELT and hybrid), straight to 8 kHz
mono, so the Android build (gomobile) needs no cgo and no libopus. It encodes
G.711 µ-law or A-law, whichever the camera's backchannel advertises, and
writes 20 ms RTP packets over the RTSP connection at the pace they are heard.
A camera whose speaker takes something else (AAC, G.726) is refused with the
codec named: "the camera's speaker takes MPEG4-GENERIC, and the box can only
send G.711". Such a camera has no `speaker`, so the console doesn't offer it.

**Low delay.** A jitter buffer of 60 ms before the first packet; never more
than 200 ms behind (a burst after a stall keeps the newest audio); packets
out of order or repeated are dropped, not replayed; an empty buffer sends
silence so the camera's clock stays steady. On release the buffered tail
(at most 200 ms) is still said. Measured end to end on one machine (the real
media plane, the real bridge, a fake camera): the camera hears a pause
about 60 ms after the person paused and speech again within a packet of
them going on.

**Never a hot microphone.** A press ends at the first of:
- the button released, the console gone, or the viewer removed (idle,
  revoked, the camera offline): the track closes, the media plane closes the
  listener's connection, and the box stops within a packet;
- no packets for 3 s: the person's audio stopped reaching the box (a silent
  microphone still sends packets, so this is the network, not a pause);
- the token's expiry and the press's cap, 10 minutes, as on the phone
  (ADR 0069's `PERSON_MAX_MS`); the media plane also ends the listener at
  `exp`;
- the camera hanging up, or not taking audio for a second.
A listener that goes first ends the talker's track too, and the console is
told why (`talkbackEnded`). A box that vanishes mid-press (unplugged, its
network gone, no goodbye) is noticed by the media plane within about 4 s:
once connected, the box sends an ICE check every second, and a listener
from which nothing at all arrives for 4 s is ended (mediasoup's own ICE
consent timeout, at least 10 s, is the backstop). A person who loses member
(removed, or made a viewer) has their live views ended with `revoked`, so a
press in progress stops at once and no new one starts on an old token. A
press another press took the speaker from before it was heard is reported
`stopped`, not failed.

**One speaker per camera, shared with typed speech.** The API's rules are
unchanged: a message is refused (`speaker_busy`) while a person talks, and a
person's press marks a playing message `interrupted`. The box enforces the
same on the camera: a press cuts a message off at once, and a message that
arrives while someone talks is refused.

**No chime.** The chime before agents' messages marks a synthetic voice
(ADR 0069); the phone path plays a person's voice without one, and so does
this. The lawful-use rules for speaking through a camera apply unchanged.

**Audited like the phone path.** Each press is a `person` speak message with
who and how long (`speak.playing`, then `speak.played`), keyed on its
producer, so the media plane's callbacks (at least once, in any order) land on
the right press: a retried start is a no-op, an end that came first leaves
the press finished and sends the box nothing, a press of the same viewer still
open when another starts (its end was lost) is finished, as is one past the
10-minute cap or of a viewer who left. The box reports how long the camera's
speaker carried it (`heard_ms`); a press the box took but found already let
go of is `speak.late` ("nobody heard it"), and one the box couldn't carry is
`speak.failed` with the box's reason (it ends the press only while it is
still held). What was said isn't recorded.

**Capability on the source.** Sources gain `talk`: push-to-talk reaches this
camera's speaker. A phone with a speaker always; an IP camera when its box
reports `talk` in its health (a G.711 backchannel, and a box new enough).
Boxes send it only to an API whose config lists the `health_talk` feature.
The Android app's own camera reports none yet: it plays clips itself, and
live audio to the phone's loudspeaker is a later step. `POST
/v1/sources/{id}/live` with `talk: true` needs `talk`, else 409 `no_speaker`
saying why.

**Console.** Hold to talk shows on cameras with `talk`, for members and up.
On an IP camera, while held it says "Connecting to the speaker…" until the
media plane says the camera hears it (`talkbackListening`, once the box is
connected), then "Talking… release to stop"; a press nobody hears within
6 s is stopped ("the camera's speaker didn't answer"). A phone's press is as
before: "Talking" at once, no timer. On either, a press the camera's side
ended shows why (the box's reason, the 10-minute cap, "the camera stopped
getting your audio"). Each state is announced in a polite live region for
screen readers. An IP camera that has a speaker but no `talk` says the box
needs updating or the speaker isn't G.711.

**Media contract.** `spec/media/whep.md`; the `listenTo` grant; the
`talkbackListening` and `talkbackEnded` events; `POST /control/rooms/{roomId}/participants/
{identity}/talkback/stop` with a reason, a message and the producer, which
the API uses when the box reports it couldn't carry a press. All optional for a media plane:
without them a press to an IP camera simply isn't heard, and the console
says so.

## Consequences

- Tested without hardware: Pion's decoder on libopus-made SILK, hybrid and
  CELT packets of a tone; the box against a fake media plane and a fake
  camera (the tone arrives as G.711, in order, within the delay bounds, and
  every way a press ends); the media plane's WHEP route, token and
  visibility rules; the API's command, token claims, failure path and
  revocation; the console's states. One test runs the real media plane
  (`SENSEPLANE_TALK_E2E_MEDIA=media go test ./internal/bridge -run
  TestTalkEndToEnd` after building `media/`): a fake console sends the tone,
  the real bridge pulls it, and Goertzel on the fake camera's G.711 finds the
  tone; then a box that vanishes without a goodbye has its press ended
  within about 4.5 s.
- Needs real hardware: browsers' Opus through the public internet, cameras'
  own backchannel buffering and echo, Digest quirks of particular models,
  and a box behind a strict NAT reaching the media plane (the same path the
  box's WHIP publishing already takes, in the other direction).
- The first fraction of a second of a press can be lost while the box
  connects (the command, the camera's `PLAY`, ICE and DTLS); the console shows
  "Connecting" until the camera hears it, so people learn to wait for it.
- Not yet: the Android app's own camera, AAC and G.726 backchannels, `rtsps`
  cameras, vendor two-way audio APIs, and talking to several cameras at once.
