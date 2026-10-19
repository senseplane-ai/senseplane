# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Watch engine: evaluates compiled triggers per source on every frame,
audio chunk and tick. Pure and synchronous; it returns "fires", and the worker
verifies them with the VLM (only when the watch has `verify`) before an event
is published. Sensor triggers are evaluated by the API, where readings arrive,
and so are condition and digest triggers (questions about activities, ADR 0057)."""

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import numpy as np

from .markers import Markers, MemoryMarkers
from .tracker import Track
from .zones import inside, zones_for

log = logging.getLogger("senseplane.brain.watches")

SOUND_MIN = 0.35
LEAVE_ABSENCE_S = 4.0
# A sustained trigger that fired and still holds is marked this long (refreshed while it holds), so a
# brain that takes the camera over does not fire it again (spec/brain/valkey.json `markers`).
HELD_MARK_S = 30.0
MOTION_MIN = 0.02  # fraction of a zone's pixels moving
# A tracking watch (mode "track", ADR 0057) whose check said no asks again this often while its condition
# holds, so "eating at the table" is found once the person sitting there starts eating.
RECHECK_S = 120.0
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


@dataclass
class Fire:
    watch_id: str
    account_id: str
    source_id: str
    t: float
    description: str
    verify: dict | None
    frame: np.ndarray | None = None
    mode: str = "alert"


class _State:
    """One trigger's state on one source. step() returns True when it fires."""

    def step(self, ctx: "Ctx") -> bool:  # pragma: no cover - interface
        raise NotImplementedError

    def holding(self) -> bool | None:
        """Sustained triggers: True while the condition that fired still holds; None for the others."""
        sustained = getattr(self, "sustained", None)
        return None if sustained is None or self._instant() else sustained.fired

    def _instant(self) -> bool:
        return False


@dataclass
class Ctx:
    t: float
    tracks: list[Track] | None = None  # set on video frames
    track_zones: dict[int, list[str]] | None = None
    motion_mask: np.ndarray | None = None
    zones: dict[str, list] = field(default_factory=dict)
    sounds: dict[str, float] | None = None  # set on audio chunks
    tick: bool = False


class Sustained:
    """Fires once when a condition has held for min_duration; re-arms when it stops."""

    def __init__(self, min_duration: float):
        self.min_duration = min_duration
        self.since: float | None = None
        self.fired = False

    def update(self, cond: bool, t: float) -> bool:
        if not cond:
            self.since, self.fired = None, False
            return False
        self.since = self.since if self.since is not None else t
        if not self.fired and t - self.since >= self.min_duration:
            self.fired = True
            return True
        return False


class ObjectsState(_State):
    def __init__(self, trig: dict):
        self.label, self.zone, self.on = trig["label"], trig.get("zone"), trig["on"]
        self.min_count = int(trig.get("min_count", 1))
        self.sustained = Sustained(float(trig.get("min_duration_s", 0)))
        self.inside_before: set[int] = set()
        # "leave" = everyone matching is gone and has stayed gone (a crouching person whose
        # track drops for a moment has not left).
        self.leave_after = max(float(trig.get("min_duration_s", 0)), LEAVE_ABSENCE_S)
        self.seen = False
        self.gone_since: float | None = None

    def _instant(self) -> bool:
        return self.on in ("enter", "leave")

    def step(self, ctx: Ctx) -> bool:
        if ctx.tracks is None:
            return False
        here = {t.id: t for t in ctx.tracks if t.label == self.label and (self.zone is None or self.zone in ctx.track_zones.get(t.id, []))}
        entered, left = set(here) - self.inside_before, self.inside_before - set(here)
        self.inside_before = set(here)
        if self.on == "enter":
            return bool(entered) and len(here) >= self.min_count
        if self.on == "leave":
            if here:
                self.seen, self.gone_since = True, None
                return False
            if not self.seen:
                return False
            self.gone_since = self.gone_since if self.gone_since is not None else ctx.t
            if ctx.t - self.gone_since >= self.leave_after:
                self.seen, self.gone_since = False, None
                return True
            return False
        if self.on == "stationary":
            return self.sustained.update(sum(1 for t in here.values() if t.stationary) >= self.min_count, ctx.t)
        return self.sustained.update(len(here) >= self.min_count, ctx.t)  # present


class MotionState(_State):
    def __init__(self, trig: dict):
        self.zone = trig.get("zone")
        self.sustained = Sustained(float(trig.get("min_duration_s", 0)))
        self._mask_cache: tuple[int, np.ndarray] | None = None

    def step(self, ctx: Ctx) -> bool:
        if ctx.motion_mask is None:
            return False
        mask = ctx.motion_mask
        if self.zone and self.zone in ctx.zones:
            h, w = mask.shape
            key = id(ctx.zones[self.zone])
            if not self._mask_cache or self._mask_cache[0] != key:
                yy, xx = np.mgrid[0:h, 0:w]
                pts = np.stack([(xx + 0.5) / w, (yy + 0.5) / h], -1).reshape(-1, 2)
                zm = np.array([inside((x, y), ctx.zones[self.zone]) for x, y in pts]).reshape(h, w)
                self._mask_cache = (key, zm)
            zm = self._mask_cache[1]
            frac = float(mask[zm].mean()) if zm.any() else 0.0
        else:
            frac = float(mask.mean())
        return self.sustained.update(frac >= MOTION_MIN, ctx.t)


class SoundState(_State):
    def __init__(self, trig: dict):
        self.cls = trig["class"]
        self.sustained = Sustained(float(trig.get("min_duration_s", 0)))

    def step(self, ctx: Ctx) -> bool:
        if ctx.sounds is None:
            return False
        return self.sustained.update(ctx.sounds.get(self.cls, 0.0) >= SOUND_MIN, ctx.t)


class ScheduleState(_State):
    def __init__(self, trig: dict):
        self.every = float(trig["every_min"]) * 60
        self.last: float | None = None

    def step(self, ctx: Ctx) -> bool:
        if not ctx.tick:
            return False
        if self.last is None or ctx.t - self.last >= self.every:
            self.last = ctx.t
            return True
        return False


class SequenceState(_State):
    def __init__(self, trig: dict):
        self.steps = [make_state(s) for s in trig["steps"]]
        self.within = float(trig["within_s"])
        self.index, self.started = 0, None

    def step(self, ctx: Ctx) -> bool:
        if self.started is not None and ctx.t - self.started > self.within:
            self.index, self.started = 0, None
        fired = False
        # Every step sees every input, so later steps keep their own state current.
        results = [s.step(ctx) for s in self.steps]
        if results[self.index]:
            if self.index == 0:
                self.started = ctx.t
            self.index += 1
            if self.index == len(self.steps):
                self.index, self.started, fired = 0, None, True
        return fired


class NoneState(_State):
    def step(self, ctx: Ctx) -> bool:
        return False


def make_state(trig: dict) -> _State:
    return {"objects": ObjectsState, "motion": MotionState, "sound": SoundState, "schedule": ScheduleState,
            "sequence": SequenceState}.get(trig["type"], lambda _t: NoneState())(trig)


def in_span(span: dict, local: datetime) -> bool:
    """Wall-clock span rules (ADR 0043; the API has the same in schedule.ts): an overnight span
    (to before from) belongs to the day it starts on, and from == to is the whole day."""
    days = span.get("days") or DAYS
    hhmm, today, yesterday = local.strftime("%H:%M"), DAYS[local.weekday()], DAYS[(local.weekday() + 6) % 7]
    start, end = span["from"], span["to"]
    if start == end:
        return today in days
    if start < end:
        return today in days and start <= hhmm < end
    if hhmm >= start:
        return today in days
    return hhmm < end and yesterday in days


def active_now(active_hours: list | None, t: float) -> bool:
    """The compiler's active_hours (UTC)."""
    if not active_hours:
        return True
    now = datetime.fromtimestamp(t, UTC)
    return any(in_span(span, now) for span in active_hours)


def in_schedule(schedule: dict | None, t: float) -> bool:
    """The watch's own schedule (Watch.active_hours) in its time zone, so it follows daylight saving."""
    if not schedule:
        return True
    try:
        tz = ZoneInfo(schedule.get("time_zone") or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        log.warning("unknown time zone %r; using UTC", schedule.get("time_zone"))
        tz = UTC
    return in_span(schedule, datetime.fromtimestamp(t, tz))


def describe(trig: dict) -> str:
    t = trig["type"]
    if t == "objects":
        return f"{trig['label']} {trig['on']}" + (f" in {trig['zone']}" if trig.get("zone") else "")
    if t == "sequence":
        return " then ".join(describe(s) for s in trig["steps"])
    if t == "sound":
        return f"sound {trig['class']}"
    if t == "schedule":
        return f"scheduled check every {trig['every_min']} min"
    return t


class WatchEngine:
    def __init__(self, markers: Markers | None = None):
        self.watches: dict[str, dict] = {}  # "account.watch" → watch
        self.states: dict[tuple[str, str], _State] = {}  # (watch key, source id) → state
        # Cooldowns and "fired and still holds" are shared across brains (ADR 0052).
        self.markers: Markers = markers if markers is not None else MemoryMarkers()
        self.holding: set[tuple[str, str]] = set()
        self.recheck: dict[tuple[str, str], float] = {}  # (watch key, source) → when a failed check may run again

    def set_watch(self, key: str, watch: dict | None):
        if watch is None or watch.get("status") == "paused":
            self.watches.pop(key, None)
        else:
            self.watches[key] = watch
        for k in [k for k in self.states if k[0] == key]:
            del self.states[k]

    def _for_source(self, account_id: str, source_id: str):
        for key, w in self.watches.items():
            if key.startswith(account_id + ".") and source_id in w["sources"]:
                trig = w["compiled"]["trigger"]
                if trig["type"] in ("sensor", "condition", "digest"):  # checked by the API (readings; ADR 0057)
                    continue
                st = self.states.get((key, source_id))
                if st is None:
                    st = self.states[(key, source_id)] = make_state(trig)
                yield key, w, st

    def check_failed(self, account_id: str, watch_id: str, source_id: str, t: float):
        """The model check of a firing said no: a tracking watch whose condition still holds asks again later."""
        key = f"{account_id}.{watch_id}"
        w, st = self.watches.get(key), self.states.get((key, source_id))
        if w and st and w.get("mode") == "track" and st.holding():
            self.recheck[(key, source_id)] = t + RECHECK_S

    def holding_now(self, account_id: str, watch_id: str, source_id: str) -> bool | None:
        """Whether the watch's condition still holds on this source (None: an instant trigger, or unknown)."""
        st = self.states.get((f"{account_id}.{watch_id}", source_id))
        return st.holding() if st else None

    def evaluate(self, account_id: str, source_id: str, ctx: Ctx, frame: np.ndarray | None = None) -> list[Fire]:
        fires = []
        for key, w, st in self._for_source(account_id, source_id):
            fired = st.step(ctx)
            held, hk = f"held:{key}:{source_id}", (key, source_id)
            holding = st.holding()
            if not holding:
                self.recheck.pop(hk, None)
            elif not fired and hk in self.recheck and ctx.t >= self.recheck[hk]:
                del self.recheck[hk]
                fired = True  # a tracking watch asks again (see check_failed)
            # Another brain fired this sustained trigger and it has held since: a handover, not a new firing.
            by_other = fired and holding is not None and hk not in self.holding and self.markers.held(held, ctx.t)
            if holding:
                self.markers.hold(held, HELD_MARK_S, ctx.t)
                self.holding.add(hk)
            elif hk in self.holding:
                self.holding.discard(hk)
                self.markers.release(held)  # it stopped holding: the next time it may fire again
            if not fired or by_other:
                continue
            comp = w["compiled"]
            if not active_now(comp.get("active_hours"), ctx.t) or not in_schedule(w.get("active_hours"), ctx.t):
                continue
            track = w.get("mode") == "track"
            # A tracking watch records every time its condition starts; only alerts are spaced by a cooldown.
            if not self.markers.claim(f"watch:{key}:{source_id}", 1.0 if track else max(float(comp.get("cooldown_s", 0)), 1.0), ctx.t):
                continue
            fires.append(Fire(w["id"], account_id, source_id, ctx.t, describe(comp["trigger"]), comp.get("verify"),
                              None if frame is None else frame.copy(), "track" if track else "alert"))
        return fires

    def on_frame(self, account_id: str, source_id: str, tracks: list[Track], motion_mask: np.ndarray | None,
                 zones: list[dict], frame: np.ndarray, t: float) -> list[Fire]:
        h, w = frame.shape[:2]
        zmap = {z["name"]: z["polygon"] for z in zones}
        tz = {tr.id: zones_for(tr.box, w, h, zones) for tr in tracks}
        return self.evaluate(account_id, source_id, Ctx(t, tracks, tz, motion_mask, zmap), frame)

    def on_audio(self, account_id: str, source_id: str, sounds: dict[str, float], t: float, frame: np.ndarray | None) -> list[Fire]:
        return self.evaluate(account_id, source_id, Ctx(t, sounds=sounds), frame)

    def on_tick(self, account_id: str, source_id: str, t: float, frame: np.ndarray | None) -> list[Fire]:
        if frame is None:
            return []
        return self.evaluate(account_id, source_id, Ctx(t, tick=True), frame)
