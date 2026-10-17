# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Shared "already alerted" markers (spec/brain/valkey.json `markers`, ADR 0052).

A camera can move to another brain at any moment (its brain died, or the API
rebalanced). Cooldowns and "this label was already announced" therefore live
in Valkey, not in one brain's memory, so a handover never posts an alert
twice. The pure pipeline and watch engine take a `Markers`; tests and offline
runs use `MemoryMarkers`, the worker passes `ValkeyMarkers`.

Times: the pure code passes its own clock (`now`, a frame's capture time) so
offline runs with synthetic times behave; Valkey expiries are wall clock,
which is the same thing in production.
"""

from __future__ import annotations

import logging
from typing import Protocol

log = logging.getLogger("senseplane.brain.markers")

PREFIX = "sp:mark:"


class Markers(Protocol):
    def claim(self, key: str, ttl_s: float, now: float) -> bool:
        """Set the marker if it is not set; True when this caller set it (SET NX)."""

    def hold(self, key: str, ttl_s: float, now: float, value: str = "1") -> None:
        """Set or refresh the marker (writes may be throttled)."""

    def held(self, key: str, now: float) -> bool:
        """Is the marker set?"""

    def value(self, key: str, now: float) -> str | None:
        """The marker's value, None when it is not set."""

    def release(self, key: str) -> None:
        """Clear the marker."""


class MemoryMarkers:
    """One process's markers. Shared between pipelines, it behaves like Valkey."""

    def __init__(self) -> None:
        self.marks: dict[str, tuple[float, str]] = {}

    def claim(self, key: str, ttl_s: float, now: float) -> bool:
        if self.held(key, now):
            return False
        self.marks[key] = (now + ttl_s, "1")
        return True

    def hold(self, key: str, ttl_s: float, now: float, value: str = "1") -> None:
        self.marks[key] = (now + ttl_s, value)

    def held(self, key: str, now: float) -> bool:
        return self.value(key, now) is not None

    def value(self, key: str, now: float) -> str | None:
        mark = self.marks.get(key)
        if mark is None:
            return None
        if mark[0] <= now:
            del self.marks[key]
            return None
        return mark[1]

    def release(self, key: str) -> None:
        self.marks.pop(key, None)


class ValkeyMarkers:
    """Markers in Valkey (sync client: the pure code runs in executor threads).

    A Valkey error never stops analysis: claim fails open (the alert is
    posted; the API dedupes events on event_key), held answers False."""

    def __init__(self, client, refresh_every_s: float = 5.0) -> None:
        self.r = client
        self.refresh_every_s = refresh_every_s
        self._written: dict[str, float] = {}

    def claim(self, key: str, ttl_s: float, now: float) -> bool:
        try:
            return bool(self.r.set(PREFIX + key, b"1", nx=True, px=max(1, int(ttl_s * 1000))))
        except Exception as err:  # noqa: BLE001
            log.warning("marker claim failed", extra={"fields": {"key": key, "error": repr(err)}})
            return True

    def hold(self, key: str, ttl_s: float, now: float, value: str = "1") -> None:
        if now - self._written.get(key, -1e18) < min(self.refresh_every_s, ttl_s / 3):
            return
        try:
            self.r.set(PREFIX + key, value.encode(), px=max(1, int(ttl_s * 1000)))
            self._written[key] = now
        except Exception as err:  # noqa: BLE001
            log.warning("marker hold failed", extra={"fields": {"key": key, "error": repr(err)}})

    def held(self, key: str, now: float) -> bool:
        try:
            return bool(self.r.exists(PREFIX + key))
        except Exception:  # noqa: BLE001
            return False

    def value(self, key: str, now: float) -> str | None:
        try:
            v = self.r.get(PREFIX + key)
        except Exception:  # noqa: BLE001
            return None
        return None if v is None else (v.decode() if isinstance(v, bytes) else str(v))

    def release(self, key: str) -> None:
        self._written.pop(key, None)
        try:
            self.r.delete(PREFIX + key)
        except Exception:  # noqa: BLE001
            pass
