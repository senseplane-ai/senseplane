# Brain tuning (2026-10-17)

What one camera costs the brain, measured before changing anything, and what
changed. Decision: [ADR 0054](../decisions/0054-brain-tuning.md).

## How it was measured

`brain/scripts/bench.py` runs the production `SourcePipeline` and
`WatchEngine` (the package watch and a "backpack present for 5 s" probe) over
every fixture in `fixtures/labels.json`, framed like the media plane's frames
feed: 5 fps, letterboxed to 640x360, JPEG quality 75, decoded again as the
brain does. CPU is process time over the analysis only (all ONNX Runtime
threads, `DETECTOR_THREADS=2`), divided by seconds of video: the share of one
core a camera keeps busy. Precision and recall are per class as in
`tests/test_perception.py` (expected labels must fire; anything not listed
as expected or allowed is a false positive). Apple M-series laptop, 206.4 s of
video in 9 fixtures, 1032 frames.

```sh
cd brain
uv run python scripts/bench.py --model yolox_s              # the adaptive rate (default)
uv run python scripts/bench.py --model yolox_s --no-gate    # the old rate
uv run python scripts/bench.py --model yolox_tiny
```

## Results

| | detector | rate | CPU per camera (cores) | detector calls | overall precision / recall | person latency (parcel, delivery) |
|---|---|---|---|---|---|---|
| before | yolox_s | old | **1.342** | 721 | 1.0 / 1.0 | 0.2 s, 0.6 s |
| after (default) | yolox_s | adaptive | **1.125** (−16 %) | 608 | 1.0 / 1.0 | 0.2 s, 0.6 s |
| tiny, old rate | yolox_tiny | old | 0.378 (−72 %) | 721 | 0.833 / 1.0 | −0.6 s, 0.6 s |
| tiny, adaptive | yolox_tiny | adaptive | 0.320 (−76 %) | 616 | 0.833 / 1.0 | −0.6 s, 0.6 s |

Per class, every run: person, vehicle, animal and sound:crying are 1.0 / 1.0.
yolox_tiny adds one false positive: a `detection.handbag` event (score 0.568)
for the courier's parcel on the doorstep clip, where the labels allow only
`backpack` (what yolox_s calls it). A negative latency means the event came
before the labelled entry time (the first visible frame of the person).

Per fixture, CPU per camera, yolox_s before → after:

| fixture | before | after | calls before → after |
|---|---|---|---|
| doorstep-parcel | 1.575 | 1.318 | 125 → 104 |
| doorstep-delivery-reversed | 1.318 | 0.992 | 137 → 104 |
| van-driving | 1.953 | 1.741 | 135 → 123 |
| dog-indoors | 1.931 | 1.487 | 100 → 78 |
| rain-window-night | 0.882 | 0.881 | 41 → 41 |
| storm-rain-night | 1.912 | 1.932 | 40 → 40 |
| night-sky-empty | 0.376 | 0.188 | 20 → 10 |
| baby-crying-audio | 0.374 | 0.131 | 23 → 8 |
| testsrc (moving test pattern) | 1.883 | 1.886 | 100 → 100 |

The watches fire identically (package watch at 34.4 s on the delivery clip,
22.8 → 23.0 s on the van clip; the stationary probe at the same times), and
the empty and rain clips still fire nothing.

The fixtures are mostly busy scenes. A real camera spends most of its time on
an unchanged picture, which now costs half to a third of what it did
(night-sky 0.376 → 0.188, a still room 0.374 → 0.131).

## What changed

- **Adaptive detector rate** (`pipeline.Config.adaptive`, on by default):
  - movement nobody is tracking yet, or a track younger than 2 s: every frame (5 fps);
  - movement that is all inside boxes the tracker already follows: 2.5 fps;
  - a picture that changes a little: 2 fps;
  - an unchanged picture: every 3 s, never less, so a mug on a desk, a parked
    car and `present` / `stationary` watches are still seen
    (`tests/test_gate.py`). The old rate looked every 5th frame (1 fps).
- The motion check (a running background on a 160x90 grey frame) still runs on
  every frame; it is what decides.
- yolox_s stays the default: yolox_tiny is 3.5x cheaper but did not hold
  precision on the fixtures. `DETECTOR_MODEL=yolox_tiny` remains available.
  If the labels allowed `handbag` on the doorstep clips, or `handbag` had a
  `min_score` of 0.6 in `spec/labels.json`, tiny would score 1.0 / 1.0 here.

## Round 2: int8 cascade

Decision: [ADR 0055](../decisions/0055-int8-detector-cascade.md). Same
benchmark, same laptop (heavily loaded during these runs, so the absolute
numbers are high; compare rows with each other).

```sh
cd brain
uv run python scripts/bench.py                                 # int8 + yolox_s confirm (default)
uv run python scripts/bench.py --model yolox_s --confirm none  # round 1 default
```

| | CPU per camera (cores) | detector calls (int8 / yolox_s) | precision / recall | person latency (parcel, delivery) |
|---|---|---|---|---|
| round 1 default (yolox_s, adaptive) | 1.108 | 0 / 608 | 1.0 / 1.0 | 0.2 s, 0.6 s |
| int8 alone | 0.447 | 612 / 0 | 0.833 / 1.0 | 0.2 s, 0.8 s |
| **int8 + yolox_s confirm (default)** | **0.604** (−45 %) | 544 / 97 | 1.0 / 1.0 | 0.2 s, 0.6 s |

Per fixture, round 1 → now:

| fixture | round 1 | now |
|---|---|---|
| doorstep-parcel | 1.280 | 0.810 |
| doorstep-delivery-reversed | 0.971 | 0.627 |
| van-driving | 1.715 | 1.091 |
| dog-indoors | 1.466 | 1.082 |
| rain-window-night | 0.862 | 0.241 |
| storm-rain-night | 1.889 | 1.136 |
| night-sky-empty | 0.190 | 0.031 |
| baby-crying-audio (still picture) | 0.135 | 0.023 |
| testsrc (moving test pattern) | 1.890 | 0.464 |

Int8 alone added a `detection.book` event (the parcel on the doorstep). Frame
by frame against yolox_s, on 149 COCO val2017 photos (not the calibration set)
and 312 fixture frames, the int8 build found 93.4 % of yolox_s's person
detections, 97.1 % of vehicles, 87 % of animals and 88.6 % of everyday
objects; most misses scored just under the threshold. Percentile and Entropy
calibration, and keeping the prediction layers in float, did not do better.
The watches fire as in round 1.
