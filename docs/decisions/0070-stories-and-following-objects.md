# 70. Multi-camera stories, and following objects and pets (never people)

Date: 2026-11-03 · Status: accepted

## Context

People ask "show me how the cat got out" or "how did this box move through
the house?". The answer is in the recordings, but spread over several
cameras and several minutes, and a clip (ADR 0037) covers one camera and one
range. The roadmap had multi-camera stories, and also following a *person*
from camera to camera. Matching people across cameras by appearance is
person re-identification, close to identifying someone (see [lawful camera
use](../lawful-use.md)). That part is dropped from the plan, not deferred.
Objects and pets are different: following a parcel, a suitcase or the dog
says nothing about who anyone is.

## Decision

### Stories

**What.** `POST /v1/stories` takes moments (event ids, or a camera with a
time range) and/or a search (memory search, as `what_happened` uses), and
makes one video in time order. An event's piece runs from 3 s before it to
5 s after it ended. Pieces on one camera that overlap or are under 2 s apart
are merged. The response is `202` with the pieces; `GET /v1/stories/{id}`
says `queued`, `rendering`, `ready` or `failed`, and once ready carries a
signed playback URL. `GET /v1/stories` lists, `DELETE` deletes,
`POST /v1/stories/{id}/link` makes a longer link (up to 7 days, default one
day) to send to a person. The console plays it in `play.html#u=…`.

**Limits.** At most 20 pieces, 3 minutes per piece and 10 minutes of
recorded video in all (gap cards come on top). A story is one sitting's
watching, and one render's cost.

**Two modes.**

- *Labelled* (default): re-encoded to 1280×720, 25 fps H.264 and, when any
  piece has sound the caller may hear, AAC stereo (silence for the pieces
  without). Each piece has a caption bar with the camera's name and the
  time it starts, in the workspace's time zone. A gap of more than a minute
  between pieces becomes a 2 s card ("+5 min, then Kitchen"). Different
  resolutions and aspect ratios are letterboxed into one frame.
- *Fast*: the recorded segments are copied as they are, like a clip,
  played as one playlist with a discontinuity between pieces. No labels,
  no cards, no re-encoding; ready in seconds.

**Where it runs.** A background job in the API (ADR 0058): `claim_stories`
claims one story at a time per process with a 15-minute lease, and a failed
render is retried twice. The API reads the segments, decrypts them (ADR
0066), and runs ffmpeg as a separate process. The media plane already has
ffmpeg but is the realtime path and has no H.264 encoder; a render belongs
with the API's other background work. A larger deployment runs it on its
worker processes (`API_WORKERS`).

**The API image** now carries an LGPL ffmpeg 8.0 build (no `--enable-gpl`,
checked at build), with OpenH264 (Cisco, BSD 2-Clause, Debian's package) as
its H.264 encoder and FFmpeg's own AAC encoder. libx264 is GPL, so it is
not used; a locally installed ffmpeg is used as it is (`FFMPEG_PATH`), with
whichever H.264 encoder it has (`STORY_H264_ENCODER` picks one). The labels
are not drawn with ffmpeg's `drawtext`, which needs FreeType and fontconfig:
the API draws them itself as raw RGBA frames with a small built-in pixel
font (`caption.ts`), and ffmpeg overlays them. Letters come out in capitals.

**Kept like a clip.** The story's segments live under
`stories/{account}/{story}/` and outlive raw retention. Rendered segments
are encrypted with HLS AES-128 under a key derived for the story
(`segmentKey(dataKey, storyId)`); fast-mode copies keep their camera's key
and IV. Each segment row names where its key comes from (`key_source`), so
playback, the key link and key rotation work for both. Deleting the
account deletes the prefix.

**Permissions.** Creating one needs a video grant covering every piece,
inside the grant's window, with `history` for pieces older than two hours
(it is a history route, ADR 0048). Sound only from cameras with an audio
grant: a piece without one is rendered silent (labelled) or served with its
audio track removed (fast, ADR 0037). A blurred-only agent (ADR 0068) is
refused with `forbidden_sense` and `details.blurred_only`: recordings
aren't blurred, and blurring every frame of a render is not cheap enough to
do here. An agent sees a story only when it could have made it. The story's
link carries the creator's sealed key (ADR 0036); the media guard checks
every piece of the story against the key's current grants, so revoking a
camera ends the link within 30 s, and a viewer without audio on a piece
with sound gets the whole story without audio. Creating one and making a
share link are audit log entries (`story.created`, `story.link_created`).

**Surfaces.** REST and OpenAPI, both SDKs, the MCP tool `make_story` (also
in the Python SDK's `senseplane.tools`), chat (the brain's `make_story`
tool takes the refs of moments it found; the answer streams a `story`
event), and the console's Stories page, fed from events picked on the
Events page and ranges added there.

### Following an object or a pet

**What.** `POST /v1/follows` takes a reference: a box (fractions of the
picture) on an event's snapshot or on a camera's recorded frame at a time,
or a description ("the brown cardboard box with red tape"); and a range of
at most 2 hours, on up to 8 cameras (default: every camera the caller may
watch over the range). A background job (`claim_follows`) returns the
route: visits per camera in time order (sightings under 30 s apart are one
visit) with a confidence and a signed link each, the handovers between
cameras, and the gaps over 15 s, each with why it wasn't seen: no camera was
recording, it wasn't looked at (the frame limit), or the cameras that were
recording didn't see it ("somewhere no camera covers, or out of sight").
By default it also makes a story of the route.

**How.** The API reads frames from the recordings: one a second around the
camera's events, one every five seconds elsewhere. At most 240 frames per
follow, shared between the cameras. It sends them to a brain 20 at a time
(`rpc.brain.follow_scan`). The brain finds candidates in each frame (YOLOX
detections that aren't people, and regions that differ from the median of
the frames, for things with no COCO class, like a cardboard box) and
compares each with the reference: 0.6 × appearance (DINOv2-small, cosine of
the class token and mean patch token) + 0.4 × colour (an HSV histogram;
DINOv2 is trained to ignore colour). From 0.82 it is a sighting; from 0.68
the vision model is asked "is this the same object?", with the reference and
the candidate side by side. Without a model, from 0.76 counts, at a lower
confidence. At most 12 model calls per follow, counted as AI checks
(purpose `follow`) like any other, and refused when the workspace's AI
checks are used up. A description needs the model: it is asked about the
biggest candidates until one matches, and that one becomes the reference.

**The model.** DINOv2-small (Meta, Apache 2.0), the int8 ONNX export by
Xenova (24 MB, pinned by SHA-256, about 40–65 ms per crop on one CPU core).
It is the smallest well-known permissively licensed image embedding that
tells individual objects apart. No open-vocabulary detector: OWLv2 and
Grounding DINO are Apache 2.0 but hundreds of MB, and YOLO-World is GPL.

**Never a person.** A description that names a person ("the man in the red
jacket", "my son", "the courier") is refused by the API before anything
runs; a person's thing ("my son's backpack") is not. A box on a person
(overlapping a YOLOX person box, inside one, or holding one) is refused by
the brain, and when a vision model is set up it is also asked whether the
selection is a person. Refusals are `403 forbidden` with `details.person`.
Candidates mostly inside a person's box are dropped before anything looks at
them, so no person is ever embedded or compared, and a description can't
lead to one. Nothing is stored about the reference but where it is (event
or camera and time, and the box): no crop, no embedding. Its vector goes to
the API and back with each batch while the follow runs, and is dropped when
it ends. Frames and crops sent to the model are blurred as the camera asks
(ADR 0068). A blurred-only agent's cameras are left out.

**Known limits.** An object carried by a person mostly lies inside the
person's box and is dropped while carried: the route shows those minutes as
a gap. An object that never moves on a camera is found only if YOLOX has a
class for it. Five-second sampling misses quick passes away from events.
These are reported as gaps, never as "it wasn't there".

**Surfaces.** REST and OpenAPI, both SDKs, the MCP tool `follow_object`
(and in `senseplane.tools`), and the console: "Follow this" on an event
draws a box on its snapshot; the Stories page shows the route.

## Consequences

- The API image grows by an ffmpeg build and OpenH264, and the
  brain image by 24 MB of weights. H.264 encoding may need patent licensing
  in some places; Cisco's licence covers only Cisco's own binaries, which
  are not used.
- Renders run one at a time per API process (the 20 s test story renders in about 2 s on a laptop core); follows take
  a brain's CPU for about 0.15 s per frame. Both are capped.
- `follow_object` and `make_story` make 14 MCP tools.
- Person following is out of the plan for good: the guard above is where
  that line is held, and it is tested.
