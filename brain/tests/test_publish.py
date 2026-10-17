# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""A Valkey publish timeout must never take the worker down: retry, keep events, keep usage."""
import asyncio
import json
from collections import deque

import redis.exceptions

from senseplane_brain import worker as worker_mod
from senseplane_brain.worker import Worker


class FlakyJS:
    """Event sink stand-in whose publish times out `failures` times, then works."""

    def __init__(self, failures: int):
        self.failures = failures
        self.sent: list[tuple[str, dict]] = []

    async def publish(self, subject, data, headers=None):
        if self.failures > 0:
            self.failures -= 1
            raise redis.exceptions.TimeoutError("timed out")
        self.sent.append((subject, json.loads(data)))


def _worker() -> Worker:
    w = Worker.__new__(Worker)  # no models: only publishing is exercised
    w.stats = {"events": 0, "publish_retries": 0, "publish_failed": 0}
    w.backlog = deque(maxlen=worker_mod.BACKLOG_MAX)
    w.usage = []
    return w


def _event(n: int):
    return ("brain.event", {"event_key": f"e{n}", "account_id": "acc", "source_id": "src", "type": "detection.person", "confidence": 0.9})


def test_a_timeout_is_retried(monkeypatch):
    monkeypatch.setattr(worker_mod, "PUBLISH_BACKOFF_S", 0)
    w, js = _worker(), FlakyJS(failures=2)
    asyncio.run(w.publish(js, [_event(1)]))
    assert [p["event_key"] for _, p in js.sent] == ["e1"]
    assert w.stats["publish_retries"] == 2 and w.stats["publish_failed"] == 0


def test_events_survive_an_outage_and_go_out_in_order(monkeypatch):
    monkeypatch.setattr(worker_mod, "PUBLISH_BACKOFF_S", 0)
    w, js = _worker(), FlakyJS(failures=worker_mod.PUBLISH_ATTEMPTS * 2)
    asyncio.run(w.publish(js, [_event(1)]))  # fails every try: kept, no exception
    asyncio.run(w.publish(js, [_event(2)]))  # the backlog retry fails too; e2 is kept behind e1
    assert js.sent == [] and len(w.backlog) == 2 and w.stats["publish_failed"] == 2
    asyncio.run(w.publish(js, [_event(3)]))  # Valkey is back
    assert [p["event_key"] for _, p in js.sent] == ["e1", "e2", "e3"]
    assert not w.backlog


def test_usage_is_kept_when_its_publish_fails(monkeypatch):
    monkeypatch.setattr(worker_mod, "PUBLISH_BACKOFF_S", 0)
    w, js = _worker(), FlakyJS(failures=worker_mod.PUBLISH_ATTEMPTS)
    w.usage = [("acc", "ai_checks", "chat")] * 3
    asyncio.run(w.flush_usage(js))
    assert js.sent == [] and w.usage == [("acc", "ai_checks", "chat")] * 3
    asyncio.run(w.flush_usage(js))
    assert [(s, p["quantity"]) for s, p in js.sent] == [("brain.usage", 3)] and w.usage == []
