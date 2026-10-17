# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Watch validation with a real vision model (needs AI_BASE_URL / AI_API_KEY /
AI_MODEL_VISION): runs three watches over every fixture through the same
pipeline and watch engine as the worker, verifies fires with the model, and
reports package-watch accuracy, model calls, cost and calls per camera-day.
    set -a; . ../.env; set +a; uv run python scripts/validate_watches.py"""

import json
import time
from pathlib import Path

from senseplane_brain.compiler import rules
from senseplane_brain.detector import YoloxDetector
from senseplane_brain.offline import FPS, decode, run_file
from senseplane_brain.pipeline import SourcePipeline
from senseplane_brain.vlm import ModelClient
from senseplane_brain.watches import WatchEngine

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
labels = json.loads((FIXTURES / "labels.json").read_text())
WATCHES = {
    "package": labels["watches"]["package"]["instruction"],
    "visitor": "Tell me when someone comes to the door and rings the bell",
    "vehicle": "Tell me if a car parks in front of the house",
}

model = ModelClient()
det = YoloxDetector()
report: dict = {"fixtures": {}, "per_watch": {k: {"fires": 0, "confirmed": 0, "vlm_calls": 0} for k in WATCHES}}
seconds = 0.0
for fixture in labels["fixtures"]:
    frames, _ = decode(str(FIXTURES / fixture))
    seconds += len(frames) / FPS
    engine = WatchEngine()
    for name, instruction in WATCHES.items():
        c = rules(instruction, [], ["video"])
        engine.set_watch(f"acc.{name}", {"id": name, "sources": ["src"], "mode": "alert", "status": "active", "compiled": c.compiled})
    fires = []
    run_file(str(FIXTURES / fixture), SourcePipeline("acc", "src", det, None),
             after_frame=lambda p, f, t: fires.extend(engine.on_frame("acc", "src", p.tracker.active, p.motion.last_mask, [], f, t)))
    out = []
    for fire in fires:
        w = report["per_watch"][fire.watch_id]
        w["fires"] += 1
        if fire.verify:
            before = model.calls
            a = model.ask(fire.frame, fire.verify["prompt"])
            w["vlm_calls"] += model.calls - before
            ok = a.yes is True and a.confidence >= fire.verify["min_confidence"]
        else:
            ok, a = True, None
        w["confirmed"] += ok
        out.append({"watch": fire.watch_id, "at_s": round(fire.t - 1_000_000.0, 1), "confirmed": ok, "answer": a.answer if a else None,
                    "confidence": a.confidence if a else None})
    report["fixtures"][fixture] = out

fire_on = set(labels["watches"]["package"]["fire_on"])
tp = sum(1 for f, evs in report["fixtures"].items() if f in fire_on and any(e["watch"] == "package" and e["confirmed"] for e in evs))
fp = sum(1 for f, evs in report["fixtures"].items() for e in evs if f not in fire_on and e["watch"] == "package" and e["confirmed"])
calls = sum(w["vlm_calls"] for w in report["per_watch"].values())
report["package_watch"] = {"deliveries": len(fire_on), "caught": tp, "false_events": fp}
report["footage_minutes"] = round(seconds / 60, 1)
report["vlm_calls_total"] = calls
report["vlm_calls_per_footage_hour"] = round(calls / (seconds / 3600), 1)
report["model"] = model.vision_model
report["cost_usd"] = round(model.cost_usd, 5)
report["cost_per_call_usd"] = round(model.cost_usd / max(model.calls, 1), 6)
print(json.dumps(report, indent=1))
