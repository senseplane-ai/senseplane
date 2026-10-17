# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""ByteTrack-style multi-object tracker with a stationary-object check.

Two-stage association on IoU: confident detections first, then low-score ones
against the tracks still unmatched (keeps a track through partial occlusion).
Constant-velocity prediction; a track is confirmed after a few hits and dropped
after a period unseen. A track whose centre barely moves for a while is marked
stationary, so a parked car does not fire again and again."""

from dataclasses import dataclass, field

import numpy as np

from .detector import Detection


def iou(a, b) -> float:
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


@dataclass
class Track:
    id: int
    label: str
    box: tuple[float, float, float, float]
    score: float
    first_seen: float
    last_seen: float
    hits: int = 1
    velocity: tuple[float, float] = (0.0, 0.0)
    confirmed: bool = False
    stationary: bool = False
    still_since: float | None = None
    best_score: float = 0.0
    verified_score: float = 0.0  # best score from the confirm detector (pipeline cascade)
    anchor: tuple[float, float] = field(default=(0.0, 0.0))

    @property
    def centre(self):
        return ((self.box[0] + self.box[2]) / 2, (self.box[1] + self.box[3]) / 2)

    def predicted(self, now: float):
        dt = now - self.last_seen
        dx, dy = self.velocity[0] * dt, self.velocity[1] * dt
        return (self.box[0] + dx, self.box[1] + dy, self.box[2] + dx, self.box[3] + dy)


class Tracker:
    def __init__(self, frame_w: int, frame_h: int, high: float = 0.5, low: float = 0.25, match_iou: float = 0.25,
                 confirm_hits: int = 2, max_age_s: float = 2.0, stationary_s: float = 10.0, stationary_move: float = 0.02,
                 revive_s: float = 30.0, revive_iou: float = 0.5):
        self.w, self.h = frame_w, frame_h
        self.high, self.low, self.match_iou = high, low, match_iou
        self.confirm_hits, self.max_age_s = confirm_hits, max_age_s
        self.stationary_s, self.stationary_move = stationary_s, stationary_move
        # A stationary track that drops out (a mug the detector misses for a few frames, a parked car
        # behind a passer-by) comes back as itself when it reappears in place within revive_s, still
        # stationary, instead of as a new moving track that would post an event again.
        self.revive_s, self.revive_iou = revive_s, revive_iou
        self.lost: list[Track] = []
        self.tracks: list[Track] = []
        self.next_id = 1

    def _match(self, tracks: list[Track], dets: list[Detection], now: float):
        pairs = sorted(
            ((iou(t.predicted(now), d.box), ti, di) for ti, t in enumerate(tracks) for di, d in enumerate(dets) if t.label == d.label),
            reverse=True,
        )
        used_t, used_d, matches = set(), set(), []
        for score, ti, di in pairs:
            if score < self.match_iou:
                break
            if ti in used_t or di in used_d:
                continue
            used_t.add(ti)
            used_d.add(di)
            matches.append((ti, di))
        return matches, [t for i, t in enumerate(tracks) if i not in used_t], [d for i, d in enumerate(dets) if i not in used_d]

    def update(self, dets: list[Detection], now: float) -> list[Track]:
        """Returns tracks that became confirmed on this frame."""
        high = [d for d in dets if d.score >= self.high]
        low = [d for d in dets if self.low <= d.score < self.high]
        matches, rest_tracks, new_dets = self._match(self.tracks, high, now)
        m2, _, _ = self._match(rest_tracks, low, now)
        newly: list[Track] = []
        for tracks_, dets_, ms in ((self.tracks, high, matches), (rest_tracks, low, m2)):
            for ti, di in ms:
                t, d = tracks_[ti], dets_[di]
                dt = max(now - t.last_seen, 1e-3)
                (ocx, ocy), t.box = t.centre, d.box
                ncx, ncy = t.centre
                t.velocity = (0.5 * t.velocity[0] + 0.5 * (ncx - ocx) / dt, 0.5 * t.velocity[1] + 0.5 * (ncy - ocy) / dt)
                t.last_seen, t.hits, t.score = now, t.hits + 1, d.score
                t.best_score = max(t.best_score, d.score)
                self._stationary(t, now)
                if not t.confirmed and t.hits >= self.confirm_hits:
                    t.confirmed = True
                    newly.append(t)
        for d in new_dets:
            back = next((t for t in self.lost if t.label == d.label and iou(t.box, d.box) >= self.revive_iou), None)
            if back is not None:
                self.lost.remove(back)
                back.box, back.last_seen, back.hits, back.score = d.box, now, back.hits + 1, d.score
                back.best_score = max(back.best_score, d.score)
                self.tracks.append(back)
                continue
            t = Track(self.next_id, d.label, d.box, d.score, now, now, best_score=d.score)
            t.anchor = t.centre
            self.next_id += 1
            self.tracks.append(t)
            if self.confirm_hits <= 1:
                t.confirmed = True
                newly.append(t)
        self.lost += [t for t in self.tracks if now - t.last_seen > self.max_age_s and t.confirmed and t.stationary]
        self.lost = [t for t in self.lost if now - t.last_seen <= self.revive_s]
        self.tracks = [t for t in self.tracks if now - t.last_seen <= self.max_age_s]
        return newly

    def _stationary(self, t: Track, now: float):
        cx, cy = t.centre
        moved = np.hypot((cx - t.anchor[0]) / self.w, (cy - t.anchor[1]) / self.h)
        if moved > self.stationary_move:
            t.anchor, t.still_since, t.stationary = (cx, cy), None, False
        else:
            t.still_since = t.still_since or now
            t.stationary = now - t.still_since >= self.stationary_s

    @property
    def active(self) -> list[Track]:
        return [t for t in self.tracks if t.confirmed]
