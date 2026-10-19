# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Activities (ADR 0057): one thing, in one place, from a start to an end.

`Spans` keeps the open activities of one source and turns "what is present
now" into brain.activity messages: one when an activity opens, one every
HEARTBEAT_S while it stays open, and one when it closes, `gap` after the thing
was last there. Pure and synchronous, like the pipeline that drives it."""

from dataclasses import dataclass

HEARTBEAT_S = 60.0
# How long something must be gone before its activity ends.
PRESENCE_GAP_S = {"group": 15.0, "object": 30.0}
SOUND_GAP_S = 10.0


def iso(t: float) -> str:
    from datetime import UTC, datetime

    return datetime.fromtimestamp(t, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class Span:
    key: str
    kind: str
    label: str
    zone: str | None
    started: float
    last_seen: float
    last_sent: float
    gap: float
    peak: int = 0
    confidence: float = 0.0
    watch_id: str | None = None
    verified: bool | None = None
    summary: str | None = None


class Spans:
    def __init__(self, account_id: str, source_id: str):
        self.account_id, self.source_id = account_id, source_id
        self.open: dict[tuple, Span] = {}  # (kind, label, zone) → span

    def _msg(self, s: Span, ended: float | None) -> tuple[str, dict]:
        p = {"activity_key": s.key, "account_id": self.account_id, "source_id": self.source_id, "kind": s.kind, "label": s.label,
             "zone": s.zone, "started_at": iso(s.started), "last_seen_at": iso(s.last_seen), "ended_at": iso(ended) if ended is not None else None,
             "peak_count": s.peak, "confidence": round(s.confidence, 3)}
        if s.kind == "watch":
            p["watch_id"], p["verified"] = s.watch_id, s.verified
            if s.summary:
                p["summary"] = s.summary
        return ("brain.activity", p)

    def seen(self, kind: str, label: str, zone: str | None, t: float, gap: float, count: int = 1, confidence: float = 0.0,
             **extra) -> list[tuple[str, dict]]:
        """`label` (in `zone`) is there at `t`: opens its activity or keeps it going."""
        k = (kind, label, zone)
        s = self.open.get(k)
        if s is None:
            key = f"{kind[:3]}:{self.source_id}:{label}:{zone or '*'}:{int(t * 1000)}"
            s = self.open[k] = Span(key, kind, label, zone, t, t, t, gap, count, confidence, **extra)
            return [self._msg(s, None)]
        s.last_seen, s.peak, s.confidence = t, max(s.peak, count), max(s.confidence, confidence)
        for name, v in extra.items():
            if v is not None:
                setattr(s, name, v)
        if t - s.last_sent >= HEARTBEAT_S:
            s.last_sent = t
            return [self._msg(s, None)]
        return []

    def tick(self, t: float, kinds: tuple[str, ...] | None = None) -> list[tuple[str, dict]]:
        """Closes the activities whose thing has been gone for their gap."""
        out = []
        for k, s in list(self.open.items()):
            if (kinds is None or s.kind in kinds) and t - s.last_seen >= s.gap:
                del self.open[k]
                out.append(self._msg(s, s.last_seen))
        return out

    def close(self, kind: str, label: str, zone: str | None, at: float) -> list[tuple[str, dict]]:
        s = self.open.pop((kind, label, zone), None)
        return [self._msg(s, max(at, s.started))] if s else []

    def close_all(self) -> list[tuple[str, dict]]:
        """The source stopped (its pipeline is torn down): everything ends where it was last seen."""
        out = [self._msg(s, s.last_seen) for s in self.open.values()]
        self.open.clear()
        return out
