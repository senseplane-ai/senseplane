# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""watch.triggered events say whether a vision model confirmed them (ADR 0028)."""
import asyncio

from senseplane_brain.vlm import Answer
from senseplane_brain.watches import Fire
from senseplane_brain.worker import Worker


def _worker(model):
    w = Worker.__new__(Worker)  # skip model loading; only verify_and_publish is exercised
    w.model = model
    w.sent = []

    async def publish(_js, items):
        w.sent.extend(items)

    w.publish = publish
    return w


def _fire(verify):
    return Fire(watch_id="wat_1", account_id="acc", source_id="src", t=1_700_000_000.0, description="a package", verify=verify)


class _Yes:
    def ask(self, *_a):
        return Answer(answer="A package is on the doorstep.", yes=True, confidence=0.92)


def test_unchecked_watch_is_marked_unverified():
    w = _worker(None)
    asyncio.run(w.verify_and_publish(None, _fire({"prompt": "Is there a package?"})))
    payload = w.sent[0][1]
    assert payload["verified"] is False
    assert "Not verified" in payload["summary"]


def test_model_confirmed_watch_is_verified():
    import numpy as np

    w = _worker(_Yes())
    f = _fire({"prompt": "Is there a package?"})
    f.frame = np.zeros((8, 8, 3), dtype=np.uint8)
    asyncio.run(w.verify_and_publish(None, f))
    assert w.sent[0][1]["verified"] is True


def test_watch_without_a_check_has_no_flag():
    w = _worker(None)
    asyncio.run(w.verify_and_publish(None, _fire(None)))
    assert w.sent[0][1]["verified"] is None
