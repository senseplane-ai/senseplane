# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""The state → reading mapping and the batching/retry forwarder, without Home Assistant."""

import asyncio
from datetime import UTC, datetime

import pytest

from senseplane.client import AuthError, SenseplaneError
from senseplane.forwarder import Forwarder, to_reading

AT = datetime(2026, 10, 16, 12, 0, tzinfo=UTC)


@pytest.mark.parametrize(
    ("device_class", "state", "unit", "want"),
    [
        ("temperature", "21.46", "°C", {"sense": "temperature", "value": 21.46, "unit": "celsius"}),
        ("temperature", "71.6", "°F", {"sense": "temperature", "value": 22.0, "unit": "celsius"}),
        ("temperature", "300.15", "K", {"sense": "temperature", "value": 27.0, "unit": "celsius"}),
        ("humidity", "48", "%", {"sense": "humidity", "value": 48.0, "unit": "percent"}),
        ("temperature", "unavailable", "°C", None),
        ("temperature", "unknown", "°C", None),
        ("temperature", "nan", "°C", None),
        ("humidity", "48", "g/m³", None),
        ("pressure", "1013", "hPa", None),
        (None, "1", None, None),
    ],
)
def test_to_reading(device_class, state, unit, want):
    got = to_reading(device_class, state, unit, AT)
    if want is None:
        assert got is None
    else:
        assert got == {**want, "at": "2026-10-16T12:00:00+00:00"}


def test_to_reading_only_senses_the_source_has():
    assert to_reading("humidity", "50", "%", AT, senses=["temperature"]) is None


def reading(v):
    return {"sense": "temperature", "value": v, "unit": "celsius", "at": AT.isoformat()}


async def test_batches_and_sends_in_order():
    sent = []

    async def post(batch):
        sent.append([r["value"] for r in batch])

    f = Forwarder(post, max_batch=2)
    for v in (1, 2, 3):
        f.add(reading(v))
    assert await f.flush()
    assert sent == [[1, 2], [3]]
    assert f.pending == 0 and f.sent == 3


async def test_keeps_readings_while_unreachable_then_sends_them():
    calls = 0

    async def post(batch):
        nonlocal calls
        calls += 1
        if calls <= 2:
            raise SenseplaneError("cannot reach Senseplane", None, retry=True)

    f = Forwarder(post)
    f.add(reading(1))
    assert not await f.flush()
    assert not await f.flush()
    assert f.pending == 1
    assert await f.flush()
    assert f.pending == 0 and f.sent == 1


async def test_drops_a_rejected_batch_and_bounds_the_queue():
    async def post(batch):
        raise SenseplaneError("this sensor does not measure humidity", 400, retry=False)

    f = Forwarder(post, max_queue=3)
    for v in range(5):
        f.add(reading(v))
    assert f.pending == 3 and f.dropped == 2  # oldest dropped while offline
    assert await f.flush()
    assert f.pending == 0 and f.dropped == 5


async def test_stops_and_asks_for_a_new_token_when_refused():
    reauth = []

    async def post(batch):
        raise AuthError()

    f = Forwarder(post, on_auth_failed=lambda: reauth.append(True))
    f.add(reading(1))
    assert not await f.flush()
    assert reauth == [True]
    f.add(reading(2))  # ignored once stopped
    assert f.pending == 1


async def test_run_retries_with_backoff_until_it_gets_through():
    attempts = []

    async def post(batch):
        attempts.append(asyncio.get_running_loop().time())
        if len(attempts) < 3:
            raise SenseplaneError("503", 503, retry=True)

    f = Forwarder(post, batch_seconds=0.01, min_backoff=0.02, max_backoff=0.1)
    f.add(reading(1))
    task = asyncio.create_task(f.run())
    for _ in range(200):
        if f.sent:
            break
        await asyncio.sleep(0.01)
    f.stop()
    await task
    assert f.sent == 1 and len(attempts) == 3
    assert attempts[1] - attempts[0] >= 0.01  # backed off (at least half of min_backoff)


async def test_a_full_batch_is_sent_without_waiting_for_the_timer():
    sent = []

    async def post(batch):
        sent.append(len(batch))

    f = Forwarder(post, batch_seconds=60, max_batch=3)
    task = asyncio.create_task(f.run())
    for v in range(3):
        f.add(reading(v))
    for _ in range(100):
        if sent:
            break
        await asyncio.sleep(0.01)
    f.stop()
    await task
    assert sent == [3]
