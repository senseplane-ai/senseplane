# 55. An int8 detector on every frame, the full model to confirm

Date: 2026-10-17 · Status: accepted

## Context

After ADR 0054 a busy camera still cost the brain about 1.1 cores with
yolox_s, which does not scale on CPU. A GPU only pays off with many busy
cameras and frames batched across them, which the brain does not do. Most of
a real camera's day is an empty or unchanged picture.

## Decision

- **An int8 build of yolox_s** (`yolox_s_int8`) looks at every frame that is
  due: static QDQ quantization, per-channel weights, calibrated on 100 pinned
  COCO val2017 photos letterboxed as the frames feed sends them, built at image
  build time (`senseplane_brain.quantize`). About 3x less CPU per frame
  (145 ms against 428 ms on two threads).
- **yolox_s confirms** what the int8 build sees that no settled track explains,
  at most every 0.4 s, and only tracks yolox_s scored high enough post events.
  Alone, the int8 build matched yolox_s on 93 % of person detections and added
  a false object event on the fixtures; the cascade keeps yolox_s's accuracy.
- **What yolox_s does not confirm is ignored for 30 s in that place**: after
  one miss for an everyday object, after three for a person, vehicle or animal
  (someone half in the frame is missed once or twice before they step in).
- **An empty picture is looked at less**: every 2 s when it changes a little
  and every 10 s when it does not, while nothing is tracked; motion that has
  shown nothing for 3 s (rain, leaves) every 0.4 s instead of every frame.
- `DETECTOR_MODEL` / `DETECTOR_CONFIRM_MODEL` (`yolox_s_int8` / `yolox_s`);
  `DETECTOR_CONFIRM_MODEL=none` runs one detector as before. A GPU stays a
  later option for when many cameras are busy at once.

Numbers: [docs/milestones/brain-tuning.md](../milestones/brain-tuning.md#round-2-int8-cascade).

## Consequences

- On the busy fixtures 1.108 → 0.604 cores per camera; an empty scene
  0.188 → 0.031, a still room 0.131 → 0.023. Precision, recall and person
  latency are unchanged (1.0 / 1.0; 0.2 s and 0.6 s).
- The image build needs network access to cocodataset.org once, and onnx and
  sympy during that step only.
- A person who stays where yolox_s missed them three times is not seen for
  up to 30 s; in practice yolox_s sees a whole person.
