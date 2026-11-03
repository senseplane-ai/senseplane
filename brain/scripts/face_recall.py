# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Face recall and cost of privacy blurring (ADR 0068): `uv run python scripts/face_recall.py`.

Downloads the public-domain photos in tests/faces/labels.json once (into SENSEPLANE_MODELS_DIR/face-recall,
never committed) and puts each into a 640x360 frame, the size the brain sends to a model, twice: as large
as it fits ("near") and at half that ("far", a face across a porch). For every hand-labelled face it reports

- found: YuNet found it (IoU >= 0.3, or each box's centre inside the other: a profile's box sits off-centre);
- covered: at least 70% of it is inside what gets pixelated (padded faces, and the heads of the people
  YOLOX sees, as the pipeline's tracks give them);

by face width, with and without the faces labelled hard (mostly turned away). Then the time added per frame.
"""

import argparse
import hashlib
import json
import statistics
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from senseplane_brain import models
from senseplane_brain.detector import YoloxDetector
from senseplane_brain.redact import Blur, Redactor, pixelate

LABELS = Path(__file__).resolve().parents[1] / "tests" / "faces" / "labels.json"
W, H = 640, 360
BINS = [(0, 20), (20, 40), (40, 70), (70, 10_000)]


def fetch(photo: dict, cache: Path) -> np.ndarray:
    dest = cache / (photo["sha256"][:16] + ".jpg")
    if not dest.exists():
        cache.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(photo["url"], headers={"User-Agent": "senseplane-face-recall/1 (open-source test set)"})
        for attempt in range(5):
            try:
                data = urllib.request.urlopen(req, timeout=120).read()
                break
            except Exception:  # noqa: BLE001 - rate limits: back off and try again
                time.sleep(15 * (attempt + 1))
        else:
            raise RuntimeError(f"could not download {photo['url']}")
        if hashlib.sha256(data).hexdigest() != photo["sha256"]:
            print(f"note: {photo['page']} changed since it was labelled; its boxes may be off")
        dest.write_bytes(data)
        time.sleep(3)
    img = cv2.cvtColor(cv2.imread(str(dest)), cv2.COLOR_BGR2RGB)
    return cv2.resize(img, (640, round(img.shape[0] * 640 / img.shape[1])), interpolation=cv2.INTER_AREA)


def frame(photo: np.ndarray, faces: list[dict], scale: float):
    """The photo at `scale` of the largest fit, centred in a 640x360 grey frame, and its faces in frame pixels."""
    h, w = photo.shape[:2]
    s = min(W / w, H / h) * scale
    img = cv2.resize(photo, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
    out = np.full((H, W, 3), 114, dtype=np.uint8)
    ox, oy = (W - img.shape[1]) // 2, (H - img.shape[0]) // 2
    out[oy:oy + img.shape[0], ox:ox + img.shape[1]] = img
    return out, [({"box": [f["box"][0] * s + ox, f["box"][1] * s + oy, f["box"][2] * s + ox, f["box"][3] * s + oy], "hard": f.get("hard", False)}) for f in faces]


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def inside(p, b) -> bool:
    return b[0] <= p[0] <= b[2] and b[1] <= p[1] <= b[3]


def centre(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=None, help="YuNet score threshold (default redact.FACE_SCORE)")
    ap.add_argument("--upscale", type=float, default=None, help="how much larger YuNet looks at the frame (default redact.FACE_UPSCALE)")
    ap.add_argument("--save", type=Path, default=None, help="write the blurred frames here, to look at")
    args = ap.parse_args()
    doc = json.loads(LABELS.read_text())
    cache = models.MODELS_DIR / "face-recall"
    redactor = Redactor()
    if args.threshold is not None:
        redactor.faces.score_threshold = args.threshold
    if args.upscale is not None:
        redactor.faces.upscale = args.upscale
    yolox = YoloxDetector("yolox_s")
    rows = []  # (width, hard, found, covered)
    times_faces, times_all, false_pos = [], [], 0
    for i, photo in enumerate(doc["photos"]):
        img = fetch(photo, cache)
        for scale in (1.0, 0.5):
            rgb, faces = frame(img, photo["faces"], scale)
            people = [d.box for d in yolox.detect(rgb) if d.label == "person"]
            vehicles = [d.box for d in yolox.detect(rgb) if d.label == "vehicle"]
            dets = [b for b, _ in redactor.faces.detect(rgb)]
            regions = redactor.boxes(rgb, Blur(faces=True), people)
            mask = np.zeros((H, W), dtype=bool)
            for r in regions:
                mask[int(max(0, r[1])):int(np.ceil(r[3])), int(max(0, r[0])):int(np.ceil(r[2]))] = True
            for f in faces:
                b = f["box"]
                found = any(iou(b, d) >= 0.3 or (inside(centre(d), b) and inside(centre(b), d)) for d in dets)
                x1, y1, x2, y2 = (int(round(v)) for v in b)
                area = max(1, (x2 - x1) * (y2 - y1))
                covered = mask[max(0, y1):y2, max(0, x1):x2].sum() / area >= 0.7
                rows.append((b[2] - b[0], f["hard"], found, covered))
            false_pos += sum(1 for d in dets if not any(iou(f["box"], d) > 0 or inside(centre(d), f["box"]) for f in faces))
            # Cost: what blurring adds to a frame on its way out (detect, then pixelate), as the worker runs it.
            for _ in range(3):
                t0 = time.perf_counter()
                out = rgb.copy()
                for r in redactor.boxes(rgb, Blur(faces=True), people):
                    pixelate(out, r)
                times_faces.append((time.perf_counter() - t0) * 1000)
                t0 = time.perf_counter()
                redactor.apply(rgb, Blur(faces=True, plates=True), people, vehicles)
                times_all.append((time.perf_counter() - t0) * 1000)
            if args.save:
                args.save.mkdir(parents=True, exist_ok=True)
                shown = cv2.cvtColor(redactor.apply(rgb, Blur(faces=True), people), cv2.COLOR_RGB2BGR)
                cv2.imwrite(str(args.save / f"{i:02d}-{'near' if scale == 1 else 'far'}.jpg"), shown)

    def line(name, sel):
        n = len(sel)
        if not n:
            return f"{name:>22}: none"
        found, cov = sum(r[2] for r in sel), sum(r[3] for r in sel)
        return f"{name:>22}: {n:3d} faces, found {found / n:6.1%}, covered {cov / n:6.1%}"

    print(f"YuNet threshold {redactor.faces.score_threshold}, upscale {redactor.faces.upscale}")
    print(line("all", rows))
    print(line("all but hard", [r for r in rows if not r[1]]))
    for lo, hi in BINS:
        print(line(f"{lo}-{hi if hi < 10_000 else ''} px wide", [r for r in rows if lo <= r[0] < hi and not r[1]]))
    print(line("doorway (20-70 px)", [r for r in rows if 20 <= r[0] < 70 and not r[1]]))
    print(f"{'unlabelled detections':>22}: {false_pos}")

    def ms(ts):
        return f"median {statistics.median(ts):.1f} ms, p95 {sorted(ts)[int(len(ts) * 0.95)]:.1f} ms, max {max(ts):.1f} ms"

    print(f"{'faces, per frame':>22}: {ms(times_faces)}")
    print(f"{'faces + plates':>22}: {ms(times_all)}")


if __name__ == "__main__":
    main()
