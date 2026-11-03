# 69. Talk-back: speaking through a camera

Date: 2026-11-03 · Status: accepted

## Context

People want to answer the door from their phone ("leave it by the gate,
thanks"), and agents want to say something where the camera is: "this camera
is monitored, the shop is closed", or a reminder in a kitchen. Live view
(ADR 0042) already brings the camera to the browser over WebRTC through the
media plane, and boxes already take commands that must run on time or never
(ADR 0067). Talking into a home is a different kind of power from watching
it, and a voice from a camera can startle or deceive, so the rules come
first: [lawful camera use](../lawful-use.md#speaking-through-a-camera).

## Decision

**Two ways to speak.**
- **Push-to-talk**, by a person in live view: hold the button, and the
  microphone goes to the camera's speaker.
- **`speak`**, for agents (MCP, REST, both SDKs) and watches: text, turned
  into speech by the server, played on the camera.

**Which cameras have a speaker.** Sources gain `speaker`. A phone on the
capture page always has one. A camera behind a box has one when the box finds
two-way audio: when it is added from the network, and each time the box
starts relaying it, the box sends an RTSP `DESCRIBE` with
`Require: www.onvif.org/ver20/backchannel` and looks for an audio track the
camera marks `sendonly` in G.711 (PCMU or PCMA at 8 kHz). It reports
`speaker` when it claims the camera and in its health reports. The phone in
the Android app reports its own camera with a speaker. WHIP sources (OBS and
other encoders) have none. The console shows "Has a speaker" and offers
push-to-talk only there; the API refuses `speak` elsewhere with 409
`no_speaker`.

**The Speak permission.** A new grant word, `speak`, per camera, off by
default. Like `control` it is only ever granted by name: `sensors` never
covers it, a Telegram chat's first grant never includes it, and the
console's access picker has **Speak** off by default. People need member and
up, for both ways; viewers can watch, not talk. Workspace keys may speak.
Agents can't push-to-talk: they speak with the speak tool.

**Push-to-talk over the media plane.** `POST /v1/sources/{id}/live` takes
`talk: true`. The viewer's token may then publish one thing: audio, with
`visibleTo` allowing only the camera's phone (`{source_id}:capture`), so no
other viewer, recorder or agent receives it. While the button is held the
browser produces a track with `appData.source: "talkback"`, and closes it on
release; the first press asks for the microphone and connects the send
transport, later presses only produce. The phone's token now subscribes to
audio. It consumes each `talkback` track, plays it, and shows "Someone is
speaking through this phone". A room has one `talkback` track at a time
(`speaker_busy` for a second). The media plane's `producer.added` and
`producer.removed` room events tell the API who talked and for how long. For
now push-to-talk works with phone cameras on the capture page only: the box
publishes over WHIP, which has no way back, and the Android app's camera is
published by the box (below).

**Speech.** The API calls an OpenAI-compatible speech endpoint,
`POST {TTS_BASE_URL}/audio/speech` with `model` (`TTS_MODEL`), `voice`
(`TTS_VOICE`), the text and `response_format: "wav"`, with `TTS_API_KEY` as a
bearer when set. To self-host, run Kokoro (Apache-2.0) behind an
OpenAI-compatible server, such as Kokoro-FastAPI (Apache-2.0); Piper is not
used (GPL). The server has one voice: a request that names a voice, a
speaker, a reference sample or anything like voice cloning is refused, so an
agent can't sound like a person it chose. Before the speech the API puts a
short two-note chime and a pause, so people hear that a machine is about to
talk. The clip as played (chime and speech, 16-bit WAV) is stored under
`speak/`, sealed with the account's key like snapshots (ADR 0066), and linked
from `GET /v1/speak-messages`, so a person can hear exactly what was said.
The retention sweep deletes clips straight from `speak_messages` (migration
0044): after the camera's retention days, whether or not it records footage
or sound; for a camera kept by size (fill mode), after the account's days; with
no days set anywhere, after 7 days. A camera that no longer exists takes its
clips at the next sweep, and an account's go with it.

**Limits.**
- 30 seconds a message, chime included (400 `message_too_long`), and at
  most 500 characters of text. Text that plainly can't be said in 30 s even
  quickly (20 characters a second, digits and symbols read as words) is
  refused before the speech service is called.
- 6 messages a minute per camera, agents and watches together, counted
  under a lock on the camera's row (429 `rate_limited`). Every message that
  cost a speech call counts, including one refused afterwards as too long.
- One speaker at a time: a message is refused (409 `speaker_busy`) while a
  person is talking through the camera or another message is still playing.
  A person's push-to-talk always wins: when it starts, the API tells the phone
  to stop any agent's message (`speakStop`) and records it as `interrupted`,
  and the phone itself stops a message the moment a `talkback` track
  appears, and doesn't play one that arrives while someone talks.

**Delivering a message.**
- A phone on the capture page: the media plane's control API gains
  `POST /control/rooms/{roomId}/participants/{identity}/speak` (and
  `.../speak/stop`), which sends that participant a `speak` event with a
  link to the clip, a path on the API that is its own credential for two
  minutes. The page fetches and plays it, and drops one it can't start within
  10 seconds rather than play it late. No phone in the room: 503
  `camera_offline`, and nothing is kept for later.
- A camera behind a box, and the Android app's own camera: a `speak` command
  over the box's command channel, with a link to the clip and a `run_by`
  deadline, exactly as for device commands (ADR 0067): a box that doesn't
  take it within 10 s gets nothing (503 `camera_offline`, "won't play
  later"), and a box that gets it after `run_by` on the API's clock refuses
  it (`late`). The box fetches the clip without its bridge token, converts it
  to 8 kHz G.711 (go2rtc's encoders, MIT) and plays it over the camera's
  RTSP backchannel: `DESCRIBE`, `SETUP` of the speaker track over the RTSP
  connection, `PLAY`, then RTP packets of 20 ms at the pace they are heard,
  then `TEARDOWN`, answering Basic or Digest challenges with the camera's
  password. The backchannel session is the bridge's own (a few hundred
  lines): go2rtc's sending path races at teardown under the race detector
  and repacks A-law into larger packets, dropping a message's tail. The
  Android app plays its own camera's messages through the phone's
  loudspeaker and shows "An automated message is playing on this phone".
  The request waits for the box's report; after that it answers 202 `sent`
  and `GET /v1/speak-messages/{id}` has the outcome. A message the box took
  and never reported is given up a minute after it should have finished:
  `failed`, "it may or may not have played", audited; a later report changes
  nothing.

**Watches may speak.** Unlike switching a device, telling people near a
camera is what a watch is for ("say the shop is closed when someone comes in
after 8"). A watch destination can be `{type: "speak", id: <camera>, text}`.
It needs a camera with a speaker the caller can see, and an agent that sets
it needs a speak grant on that camera, as it would to speak itself. An agent
may add speak actions only to watches it made, never to a person's. The API
records which agent added each speak action (`added_by_agent`, set by the
server, never taken from the client, and not shown in answers). When the
watch fires (`watch.triggered`, never `watch.unchecked`), the message is
queued and said by one API process (ADR 0058), as whoever added the action:
that agent must still exist and have its speak grant then, or nothing is
said and the refusal is audited. An action a person added is said as the
watch. A watch's message not said within a minute is dropped.
Workflows will reuse the same action.

**Every use is audited.** `speak.<outcome>` entries (playing, played, sent,
refused, offline, late, failed, interrupted) with who and through what (the
console, an agent's name, a workspace key, a watch), the camera, the
duration and, for agents and watches, the text. People's push-to-talk is
audited with who and how long; what they said isn't recorded. `live.start`
says when a live session may talk. `GET /v1/speak-messages` lists everything
said, newest first; an agent sees only its own.

**Surfaces.**
- REST: `POST /v1/sources/{id}/speak`, `GET /v1/speak-messages[/{id}]`,
  `talk` on live view, `speaker` on sources, and `speak` destinations.
- MCP: a 13th tool, `speak`, whose description tells the agent to say it is
  an automated assistant, never to pretend to be a person, and the limits.
- SDKs: `sources.speak` and `speakMessages` (TypeScript), `sources.speak`
  and `speak_messages` (Python), and the speak tool in both toolkits.
- Console: Speak in the access picker, "Has a speaker", and Hold to talk in
  the large live view.
- Media contract: the `talkback` source, the `speak` and `speakStop`
  events, the control API's speak routes and `speaker_busy`.

## Consequences

- An agent with a speak grant can talk to whoever is near a camera. The
  grant is per camera and off by default, every message is kept and audited,
  the voice is plainly synthetic and announced by a chime, and the rate is
  bounded. It still can say something unwelcome; the lawful-use rules ask
  that agents say they are automated.
- The phone's microphone hears what its speaker plays, so a recording of a
  camera that records sound includes what was said through it.
- Browsers may refuse to play sound on the capture page until someone has
  tapped it; the page then shows "Tap to let this phone play sound".
- Not yet: push-to-talk to IP cameras and to the Android app's camera (the
  box would need to receive WebRTC audio and convert Opus to G.711), vendor
  two-way audio APIs for cameras without an ONVIF backchannel, AAC
  backchannels, `rtsps` cameras, talking to several cameras at once, and
  choosing among a few synthetic voices.
