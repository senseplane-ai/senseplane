# 68. Blurring faces and number plates before footage leaves the brain

Date: 2026-11-03 · Status: accepted

## Context

Privacy masks (ADR 0024, `api/src/frames.ts`) black out fixed parts of the
picture: a neighbour's window, the street. They can't follow a person
walking up to the door or a car pulling into the drive. People who share
their cameras with an AI model, an agent or a Telegram chat want faces and
number plates hidden in what is shared, without giving up the recording
itself. Senseplane never identifies anyone (see [lawful camera
use](../lawful-use.md)); this only finds faces and plates to hide them.

## Decision

**Where.** Faces and plates are pixelated in the brain, in every frame that
leaves it:

- every frame sent to a model: watch checks (and a sequence's "before"
  frame), look, ask, chat looks and event snapshots looked at in a chat,
  and backtests on stored snapshots;
- every snapshot: event snapshots, the latest snapshot (`/now`, the
  console), and the snapshot returned with a look or an answer.

Masks still come first: the API blacks out masked areas before a frame
reaches the brain, and blurring keeps them black. **Recordings stay as
recorded**: segments are not decoded or re-encoded, so playback, clips and
live view show the original picture. Exports carry snapshots as they were
stored. A snapshot stored before blurring was turned on stays as it was,
except for an agent that only sees blurred media (below).

**Only on frames on their way out.** Detection runs on the frames that
leave, not on the five frames a second the brain analyses, and its models
load the first time a camera asks for blurring. A brain whose cameras never
ask loads nothing.

**Settings.** `blur_faces` and `blur_plates`, per account (`PATCH
/v1/account`, off by default) and per camera (`PATCH /v1/sources/{id}`;
null follows the account). The API sends each camera's effective setting to
the brain with its zones and masks (`blur` in `sp:sources`), again for every
camera when the account's setting changes. In the console: two switches
next to the privacy masks, and the workspace defaults with the recording
defaults.

**Agents that only see blurred media.** A grant can be `blurred_only`. For
the sources it covers, that agent's looks, answers and chat get blurred
frames whatever the camera's setting (`blur` on the brain request), its
snapshot links are blurred again by a brain on the way out (`rpc.brain.redact`,
so a snapshot from before blurring was on is covered too; if no brain
answers, the snapshot is refused rather than served raw), and it gets no
raw video: playback, clips and live view are refused with
`forbidden_sense` and `details.blurred_only`, and its events carry no clip
link. Media links carry a `bo` claim, and the media guard (ADR 0036) also
reads the flag from the agent's current grants, so a grant made
blurred-only reaches links issued before it within the guard's cache
window. When an agent has several grants on a source, a blurred-only one
wins: when in doubt, blur.

**Faces: YuNet** (OpenCV Zoo, `face_detection_yunet_2026may.onnx`, MIT,
230 KB), through ONNX Runtime like the detector. The frame is looked at
1.5 times larger so faces near the model's 10 px floor are found, with a
low score threshold (0.3). Each face box is padded by 35% per side and
pixelated to six cells across, then smoothed. To err towards blurring too
much, the top of every person the tracker follows is blurred too when no
face was found inside it: someone turned away, under a cap, or too small.

**Plates: LPD-YuNet** (OpenCV Zoo, `license_plate_detection_lpd_yunet_2023mar.onnx`,
4.1 MB). Its folder's LICENSE is Apache 2.0 and says it covers every file
there, weights included. It runs through OpenCV's DNN module, which takes
the frame at its own size (the ONNX file fixes 320x240, too small for a
plate across a drive), on each vehicle the tracker follows (up to four,
enlarged), or on the whole frame for a stored snapshot. **It was trained on
Chinese plates**, so elsewhere it is a best effort: it finds a blue Chinese
plate and missed the white European plates in our van fixture. The
settings, the console and the docs say so.

The plate models we checked and did not take:

| Model | Code | Weights | Why not |
|---|---|---|---|
| ankandrew open-image-models / fast-alpr plate detectors | MIT | No licence stated; trained with a fork of YOLOv9 (GPL-3.0); the maintainer says he doesn't know whether the GPL applies | Unclear |
| Ultralytics-trained plate models (e.g. morsetechlab yolov11) | AGPL-3.0 | AGPL-3.0 | Rejected |
| OpenALPR | AGPL-3.0 | AGPL-3.0 | Rejected |
| RT-DETRv2 plate models on Hugging Face (Topurrra and its exports) | Apache 2.0 | Apache 2.0 | Trained on Open Images (CC BY), weak (top scores 0.10-0.15) |
| PaddleDetection PP-Vehicle plate detector | Apache 2.0 | No explicit weight licence | Unclear, and needs Paddle |

**Our own plate model, next.** To find plates worldwide, train a `plate`
class into the brain's own YOLOX (Apache 2.0), fine-tuned from yolox_s or
yolox_tiny at 640, then int8 like the detector (ADR 0055), and swap it in
behind `PlateDetector` (`redact.py`). Data, each to be checked again before
use:

- **CCPD** (Chinese plates, about 300,000 images): MIT, the authors' own
  statement and LICENSE file.
- **RobertLucian/license-plate-dataset** (Romanian plates, small): MIT.
- **Open Images V7, "Vehicle registration plate"** (worldwide): annotations
  CC BY 4.0, images listed as CC BY 2.0. Not on our list of licences
  (MIT, BSD, ISC, Apache 2.0, MPL 2.0), so only if we decide CC BY with
  attribution is acceptable for training data.
- Not usable: UFPR-ALPR and RodoSol-ALPR (academic only), AOLP (no
  commercial use), openalpr/benchmarks (AGPL-3.0); Roboflow Universe sets
  marked public domain often relabel Open Images, so their provenance is
  unclear.

Until then the vehicle crops are where plates are looked for, so swapping
the model changes nothing else.

**Measured** (`brain/scripts/face_recall.py`, tests/faces/labels.json): 23
public-domain photos of people at doors, desks and on paths (US federal
works on Wikimedia Commons, downloaded for the check, never committed), 56
faces labelled by hand, each photo put into a 640x360 frame at full size
and at half, so 112 faces. Faces 20-70 px wide, a face at a doorway: 98.3%
found by YuNet, 98.3% inside what gets blurred (59 faces). All faces but
those mostly turned away: 96.5% found, 98.8% covered (86). Including those:
84.8% found, 92.9% covered (112). The time added to a 640x360 frame on an
Apple M1 Max with two threads: median 21 ms, p95 30 ms for faces; with
plates on vehicles, median 23 ms, p95 102 ms with several vehicles in view.
The doorstep fixture can't be used for this: its publisher had already
pixelated the face.

## Consequences

- Blurring helps, but it is not a guarantee: a face can be missed (turned
  away and the person not tracked, too small, in a reflection), and plates
  outside China often are. Recordings are not blurred. The lawful-use page
  says so.
- A camera with blurring on costs a face pass per frame that leaves the
  brain: one per event snapshot, one every 10 s for the latest snapshot,
  and one per model call. Plates cost a pass per tracked vehicle.
- Detection only: no face crop, box or embedding is kept or sent; boxes
  live only while a frame is being blurred.
- Model inputs are blurred, so a watch that asks about a face ("is it the
  postman?") gets a worse answer on a blurred camera. That is the point.
- Re-encoding recordings blurred (a second, blurred rendition for agents
  and shared links) is left for later, and multi-camera stories will reuse
  the snapshot path.
