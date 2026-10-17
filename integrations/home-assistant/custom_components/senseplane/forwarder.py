# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Turns Home Assistant sensor states into Senseplane readings and sends them
in batches, retrying with backoff while Senseplane is unreachable.

No Home Assistant imports: states come in as plain values, so this is
testable on its own.
"""

from __future__ import annotations

import asyncio
import logging
import random
from collections import deque
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

from .client import AuthError, SenseplaneError
from .const import BATCH_SECONDS, MAX_BATCH, MAX_QUEUE

_LOGGER = logging.getLogger(__name__)

Reading = dict[str, Any]


def to_reading(
    device_class: str | None,
    state: str | None,
    unit: str | None,
    at: datetime,
    senses: tuple[str, ...] | list[str] = ("temperature", "humidity"),
) -> Reading | None:
    """A reading from a sensor state, or None when it isn't one we can send.

    Temperatures are sent in Celsius (Fahrenheit and Kelvin are converted);
    humidity in percent. Unknown, unavailable and non-numeric states are skipped.
    """
    if device_class not in senses or state is None:
        return None
    try:
        value = float(state)
    except (TypeError, ValueError):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    unit = (unit or "").strip()
    if device_class == "temperature":
        if unit in ("°F", "F"):
            value = (value - 32) * 5 / 9
        elif unit == "K":
            value = value - 273.15
        elif unit not in ("°C", "C", ""):
            return None
        return {"sense": "temperature", "value": round(value, 2), "unit": "celsius", "at": at.isoformat()}
    if unit not in ("%", ""):
        return None
    return {"sense": "humidity", "value": round(value, 2), "unit": "percent", "at": at.isoformat()}


class Forwarder:
    """Queues readings and sends them every ``batch_seconds``.

    On a retryable failure the batch stays queued and the next attempt waits
    longer (2 s doubling to 5 min, with jitter). A rejected batch (400) is
    dropped. A refused token stops the forwarder and calls ``on_auth_failed``.
    """

    def __init__(
        self,
        post: Callable[[list[Reading]], Awaitable[Any]],
        *,
        batch_seconds: float = BATCH_SECONDS,
        max_batch: int = MAX_BATCH,
        max_queue: int = MAX_QUEUE,
        min_backoff: float = 2.0,
        max_backoff: float = 300.0,
        on_auth_failed: Callable[[], None] | None = None,
    ) -> None:
        self._post = post
        self._batch_seconds = batch_seconds
        self._max_batch = max_batch
        self._queue: deque[Reading] = deque(maxlen=max_queue)
        self._min_backoff = min_backoff
        self._max_backoff = max_backoff
        self._backoff = 0.0
        self._failures = 0
        self._on_auth_failed = on_auth_failed
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()  # one batch in flight (run() and a final flush on unload)
        self._stopped = False
        self.sent = 0
        self.dropped = 0

    @property
    def pending(self) -> int:
        return len(self._queue)

    def add(self, reading: Reading) -> None:
        if self._stopped:
            return
        if len(self._queue) == self._queue.maxlen:
            self.dropped += 1  # deque drops the oldest
        self._queue.append(reading)
        if len(self._queue) >= self._max_batch:
            self._wake.set()

    def stop(self) -> None:
        self._stopped = True
        self._wake.set()

    async def flush(self) -> bool:
        """Sends what is queued, one batch at a time. False when it should retry later."""
        async with self._lock:
            return await self._flush()

    async def _flush(self) -> bool:
        while self._queue and not self._stopped:
            batch = [self._queue[i] for i in range(min(self._max_batch, len(self._queue)))]
            try:
                await self._post(batch)
            except AuthError:
                _LOGGER.error("Senseplane refused the integration token; readings are paused until it is updated")
                self._stopped = True
                if self._on_auth_failed:
                    self._on_auth_failed()
                return False
            except SenseplaneError as err:
                if err.retry:
                    _LOGGER.warning("Senseplane is unavailable (%s); will retry", err)
                    return False
                _LOGGER.error("Senseplane rejected %d readings: %s", len(batch), err)
                self.dropped += len(batch)
            else:
                self.sent += len(batch)
            for _ in batch:
                self._queue.popleft()
        return True

    async def run(self) -> None:
        """Flushes forever until stopped (run as a background task)."""
        while not self._stopped:
            wait = self._backoff or self._batch_seconds
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=wait)
            except TimeoutError:
                pass
            self._wake.clear()
            if self._stopped:
                break
            if await self.flush():
                self._backoff, self._failures = 0.0, 0
            else:
                base = min(self._min_backoff * 2**self._failures, self._max_backoff)
                self._failures += 1
                self._backoff = base / 2 + random.uniform(0, base / 2)
