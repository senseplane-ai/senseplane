# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Perception benchmark on the fixtures (docs/milestones/brain-tuning.md).

Runs the production SourcePipeline + WatchEngine over every fixture in
fixtures/labels.json, framed like the media plane's frames feed (5 fps,
640x360 letterboxed, JPEG quality 75, decoded again as the brain does), and
reports per fixture and in total:

- CPU seconds per second of video (process time, all threads), i.e. the CPU
  one camera costs; and wall time;
- detector calls;
- per-class precision/recall against the labels, as tests/test_perception.py;
- person first-event latency on the doorstep clips;
- when the package watch and a stationary "backpack present 5 s" probe fire.

    uv run python scripts/bench.py --model yolox_s
    uv run python scripts/bench.py --model yolox_tiny --json out.json
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from senseplane_brain.compiler import rules  # noqa: E402
from senseplane_brain.detector import DEFAULT_CONFIRM_MODEL, DEFAULT_MODEL, detectors  # noqa: E402
from senseplane_brain.offline import FPS, decode  # noqa: E402
from senseplane_brain.pipeline import Config, SourcePipeline  # noqa: E402
from senseplane_brain.sound import SoundClassifier  # noqa: E402
from senseplane_brain.watches import WatchEngine  # noqa: E402

FIXTURES = Path(os.environ.get("FIXTURES_DIR", ROOT.parent / "fixtures"))
T0 = 1_000_000.0


class Counting:
    def __init__(self, inner):
        self.inner, self.calls = inner, 0

    def detect(self, rgb):
        self.calls += 1
        return self.inner.detect(rgb)


def jpeg_roundtrip(frame: np.ndarray, quality: int) -> np.ndarray:
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(frame, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, quality])
    return cv2.cvtColor(cv2.imdecode(buf, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)


def label_of(p: dict) -> str:
    return f"sound:{p['labels'][0]}" if p["type"] == "sound.detected" else p["labels"][0]


def run_fixture(name: str, det: Counting, snd, cfg: Config | None, quality: int, confirm: Counting | None = None):
    frames, pcm = decode(str(FIXTURES / name))
    frames = [jpeg_roundtrip(f, quality) for f in frames] if quality else list(frames)
    p = SourcePipeline("acc", "src", det, snd, config=cfg, confirm=confirm)
    engine = WatchEngine()
    pkg = rules("Tell me if a package is left at the front door", [], ["video"]).compiled
    engine.set_watch("acc.wat_pkg", {"id": "wat_pkg", "sources": ["src"], "mode": "alert", "status": "active", "compiled": pkg})
    probe = {"trigger": {"type": "objects", "label": "backpack", "on": "present", "min_duration_s": 5}, "cooldown_s": 3600}
    engine.set_watch("acc.wat_probe", {"id": "wat_probe", "sources": ["src"], "mode": "alert", "status": "active", "compiled": probe})
    events, fires = [], []
    det.calls = 0
    if confirm:
        confirm.calls = 0
    cpu0, wall0 = time.process_time(), time.perf_counter()
    nxt = 0
    for i, frame in enumerate(frames):
        t = i / FPS
        while nxt + 16000 <= pcm.size and nxt / 16000 <= t:
            events += [(t, s, x) for s, x in p.on_audio(pcm[nxt:nxt + 16000], T0 + nxt / 16000)]
            nxt += 16000
        events += [(t, s, x) for s, x in p.on_frame(frame, T0 + t)]
        fires += [(f.watch_id, round(f.t - T0, 1)) for f in engine.on_frame("acc", "src", p.tracker.active, p.motion.last_mask, [], frame, T0 + t)]
    cpu, wall = time.process_time() - cpu0, time.perf_counter() - wall0
    seconds = len(frames) / FPS
    brain_events = [(t, x) for t, s, x in events if s == "brain.event"]
    return {
        "seconds": round(seconds, 1), "cpu_s": round(cpu, 2), "cpu_per_video_s": round(cpu / seconds, 3), "wall_per_video_s": round(wall / seconds, 3),
        "detector_calls": det.calls, "confirm_calls": confirm.calls if confirm else 0, "frames": len(frames),
        "fired": sorted({label_of(x) for _, x in brain_events}),
        "person_first": min((t for t, x in brain_events if x["type"] == "detection.person"), default=None),
        "watch_fires": fires,
    }


def score(results: dict, truth: dict) -> dict:
    stats: dict[str, dict[str, int]] = {}
    for name, tr in truth.items():
        fired, expected = set(results[name]["fired"]), {e["label"] for e in tr["expect"]}
        for cls in fired | expected:
            s = stats.setdefault(cls, {"tp": 0, "fp": 0, "fn": 0})
            if cls in expected and cls in fired:
                s["tp"] += 1
            elif cls in expected:
                s["fn"] += 1
            elif cls not in tr["allow"]:
                s["fp"] += 1
    tp = sum(s["tp"] for s in stats.values())
    fp = sum(s["fp"] for s in stats.values())
    fn = sum(s["fn"] for s in stats.values())
    return {
        "per_class": {c: {"precision": round(s["tp"] / max(s["tp"] + s["fp"], 1), 3), "recall": round(s["tp"] / max(s["tp"] + s["fn"], 1), 3), **s} for c, s in sorted(stats.items())},
        "overall": {"precision": round(tp / max(tp + fp, 1), 3), "recall": round(tp / max(tp + fn, 1), 3), "tp": tp, "fp": fp, "fn": fn},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.environ.get("DETECTOR_MODEL", DEFAULT_MODEL))
    ap.add_argument("--confirm", default=os.environ.get("DETECTOR_CONFIRM_MODEL", DEFAULT_CONFIRM_MODEL), help='"none": no cascade')
    ap.add_argument("--threads", type=int, default=int(os.environ.get("DETECTOR_THREADS", "2")))
    ap.add_argument("--quality", type=int, default=75, help="JPEG quality of the feed (0: raw frames)")
    ap.add_argument("--no-gate", action="store_true", help="fixed gating (adaptive=False): detector on motion or every 5th frame")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--json")
    a = ap.parse_args()
    os.environ["DETECTOR_THREADS"] = str(a.threads)
    truth = json.loads((FIXTURES / "labels.json").read_text())["fixtures"]
    names = a.only or list(truth)
    finder, sure = detectors(a.model, a.confirm)
    det, snd, confirm = Counting(finder), SoundClassifier(), Counting(sure) if sure else None
    cfg = Config(adaptive=False) if a.no_gate and "adaptive" in Config.__dataclass_fields__ else None
    results = {n: run_fixture(n, det, snd, cfg, a.quality, confirm) for n in names}
    total_s = sum(r["seconds"] for r in results.values())
    total_cpu = sum(r["cpu_s"] for r in results.values())
    doors = {n: results[n]["person_first"] for n in names if n.startswith("doorstep")}
    latency = {n: (round(t - next(e["from"] for e in truth[n]["expect"] if e["label"] == "person"), 2) if t is not None else None) for n, t in doors.items()}
    out = {
        "model": a.model, "confirm": a.confirm if confirm else None, "threads": a.threads, "jpeg_quality": a.quality, "gate": not a.no_gate,
        "cpu_per_camera": round(total_cpu / total_s, 3), "detector_calls": sum(r["detector_calls"] for r in results.values()),
        "confirm_calls": sum(r["confirm_calls"] for r in results.values()),
        "frames": sum(r["frames"] for r in results.values()), "video_s": round(total_s, 1),
        "person_latency_s": latency, **(score(results, truth) if not a.only else {}), "fixtures": results,
    }
    print(json.dumps(out, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
