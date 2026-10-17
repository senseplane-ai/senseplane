# 54. An adaptive detector rate; yolox_s stays the default

Date: 2026-10-17 · Status: accepted · The default detector is changed by ADR 0055 (int8 cascade)

## Context

A camera cost the brain 1.34 cores with yolox_s (measured on the fixtures,
framed like the frames feed: 5 fps, 640x360, JPEG): the detector ran on every
frame while anything moved and on every 5th frame otherwise. yolox_tiny was
an option, and most of a real camera's day is an unchanged picture.

## Decision

- The detector runs at an adaptive rate: every frame for new movement and
  young tracks, 2.5 fps for movement the tracker already follows, 2 fps when
  the picture changes a little, and every 3 s on an unchanged picture, so
  stationary objects and `present` / `stationary` watches are still seen.
- yolox_s stays the default. yolox_tiny costs a quarter of the CPU but added a
  false-positive object event on the fixtures (precision 0.833 against 1.0),
  so it is opt-in (`DETECTOR_MODEL=yolox_tiny`).
- `brain/scripts/bench.py` is how a change to perception is judged: CPU per
  camera, detector calls, precision/recall and person latency on the fixtures.

Numbers: [docs/milestones/brain-tuning.md](../milestones/brain-tuning.md).
yolox_s 1.342 → 1.125 cores per camera on the (busy) fixtures, an unchanged
picture 0.376 → 0.188, precision, recall and person latency unchanged.

## Consequences

- A still camera costs about half what it did; a busy one about 16 % less.
- Stationary objects are noticed up to 3 s later than before (was 1 s).
- Switching to yolox_tiny is a label decision (`handbag` min score), not a code
  change.
