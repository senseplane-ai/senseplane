# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""watch.triggered events say whether a vision model confirmed them (ADR 0028)."""
import asyncio

from senseplane_brain.vlm import Answer
from senseplane_brain.watches import Fire, WatchEngine
from senseplane_brain.worker import Worker


def _worker(model):
    w = Worker.__new__(Worker)  # skip model loading; only verify_and_publish is exercised
    w.model = model
    w.engine, w.watch_spans = WatchEngine(), {}
    w.sent = []

    async def publish(_js, items):
        w.sent.extend(items)

    w.publish = publish
    return w


def _event(w):
    return next(p for subject, p in w.sent if subject == "brain.event")


def _fire(verify):
    return Fire(watch_id="wat_1", account_id="acc", source_id="src", t=1_700_000_000.0, description="a package", verify=verify)


class _Yes:
    def ask(self, *_a):
        return Answer(answer="A package is on the doorstep.", yes=True, confidence=0.92)


def test_unchecked_watch_is_marked_unverified():
    w = _worker(None)
    asyncio.run(w.verify_and_publish(None, _fire({"prompt": "Is there a package?"})))
    payload = _event(w)
    assert payload["verified"] is False
    assert "Not verified" in payload["summary"]


def test_model_confirmed_watch_is_verified():
    import numpy as np

    w = _worker(_Yes())
    f = _fire({"prompt": "Is there a package?"})
    f.frame = np.zeros((8, 8, 3), dtype=np.uint8)
    asyncio.run(w.verify_and_publish(None, f))
    assert _event(w)["verified"] is True
    # The watch also leaves an activity (ADR 0057); an instant trigger's has no length.
    opened, closed = [p for subject, p in w.sent if subject == "brain.activity"]
    assert opened["kind"] == "watch" and opened["watch_id"] == "wat_1" and opened["verified"] is True and opened["ended_at"] is None
    assert closed["activity_key"] == opened["activity_key"] and closed["ended_at"] == closed["started_at"]


def test_watch_without_a_check_has_no_flag():
    w = _worker(None)
    asyncio.run(w.verify_and_publish(None, _fire(None)))
    assert _event(w)["verified"] is None
