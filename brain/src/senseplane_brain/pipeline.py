# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Per-source cascade: signal → perception → tracking/zones → episodes → events,
and activities (what is present, and where, from when to when; ADR 0057).

Pure and synchronous, so the Valkey worker and offline tests drive the same
code. Outputs are (subject, payload) pairs, messages of spec/brain/valkey.json.
Cooldowns and "already announced" live in `markers` (shared in Valkey by the
worker, ADR 0052), so a camera moved to another brain never alerts twice."""

import base64
import uuid
from dataclasses import dataclass, field

import cv2
import numpy as np

from . import labels
from .activity import PRESENCE_GAP_S, SOUND_GAP_S, Spans
from .detector import YoloxDetector
from .markers import Markers, MemoryMarkers
from .signal import MotionDetector, loudness_dbfs
from .sound import SoundClassifier
from .telemetry import child_span
from .tracker import Track, Tracker, iou
from .zones import zones_for

SOUND_TEXT = {"crying": "crying", "glass_break": "glass breaking", "alarm": "an alarm", "dog": "a dog barking", "speech_present": "people talking"}
# A confirmed track becomes an event only once its best score reaches this (spec/labels.json).
# Animals need more: crouching people and bags score as "dog" around 0.5; small objects need more too.
EVENT_MIN_SCORE = labels.MIN_SCORE
SOUND_THRESHOLDS = {"crying": 0.35, "glass_break": 0.4, "alarm": 0.4, "dog": 0.45, "speech_present": 0.6}
# "Announced in the running episode" outlives a brain by this long (refreshed while the label is active).
EPISODE_MARK_S = 30.0


@dataclass
class Config:
    motion_gate: float = 0.003  # fraction of the frame that must move to wake the detector
    idle_detect_every: int = 5  # adaptive=False: run the detector every Nth frame when nothing moves
    # Adaptive rate (docs/milestones/brain-tuning.md): every frame (5 fps) while something moves; 2 fps while
    # the picture changes a little; every still_detect_s on an unchanged picture, so stationary objects
    # (`present`, `stationary`) are still seen.
    adaptive: bool = True
    quiet_detect_s: float = 0.5
    still_detect_s: float = 3.0
    # With nothing tracked, a quiet or unchanged picture is looked at less often: nobody is in view, and
    # whatever arrives moves on its way in.
    empty_quiet_detect_s: float = 2.0
    empty_still_detect_s: float = 10.0
    # Motion where the detector has found nothing for empty_motion_after_s (rain, leaves, headlights) is
    # looked at this often instead of on every frame, until it finds something again. Not sooner: a person
    # walking up is often preceded by a second of shadow or a door opening.
    empty_motion_detect_s: float = 0.4
    empty_motion_after_s: float = 3.0
    still_motion: float = 0.0005  # below this fraction of moving pixels the picture is unchanged
    # Movement the tracker already follows (every moving pixel inside a confirmed track's box, no new
    # track) is detected at this interval instead of on every frame.
    tracked_detect_s: float = 0.4
    new_track_s: float = 2.0  # a track this young keeps the full rate
    episode_grace_s: float = 5.0  # an episode ends this long after its last active track
    sound_cooldown_s: float = 30.0
    sound_events: tuple[str, ...] = ("crying", "glass_break", "alarm", "dog")
    # Everyday objects (every label but person/vehicle/animal) are mostly scenery, so they post fewer
    # events: none for what is in view when the pipeline starts, and at most one per label per source
    # in this long (episodes alone would repeat for a mug on a busy desk). Watches still see them.
    object_warmup_s: float = 15.0
    object_event_cooldown_s: float = 300.0
    # Cascade (with a confirm detector): the cheap detector looks at every frame due; something it sees that
    # no settled track explains is checked by the confirm detector, at most once per confirm_every_s, and
    # only tracks the confirm detector scored high enough post events. What the confirm detector does not
    # find is ignored for reject_s, so a false "book" on a shelf costs one check per reject_s; a person,
    # vehicle or animal only after reject_group_misses misses in the same place (someone half in the frame
    # at the door is missed once or twice before they step in).
    candidate_score: float = 0.25
    confirm_every_s: float = 0.4
    reject_s: float = 30.0
    reject_group_misses: int = 3


@dataclass
class Episode:
    id: str
    started: float
    last_active: float
    labels: dict[str, str] = field(default_factory=dict)  # label → event_key


def iso(t: float) -> str:
    from datetime import UTC, datetime

    return datetime.fromtimestamp(t, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class SourcePipeline:
    def __init__(self, account_id: str, source_id: str, detector: YoloxDetector | None, sound: SoundClassifier | None,
                 width: int = 640, height: int = 360, config: Config | None = None, markers: Markers | None = None,
                 confirm: YoloxDetector | None = None):
        self.account_id, self.source_id = account_id, source_id
        self.detector, self.sound, self.confirm = detector, sound, confirm
        self.w, self.h = width, height
        self.cfg = config or Config()
        self.markers: Markers = markers if markers is not None else MemoryMarkers()
        self.motion = MotionDetector()
        self.tracker = Tracker(width, height)
        self.zones: list[dict] = []
        self.episode: Episode | None = None
        self.frame_no = 0
        self.last_detect_t = -1e18
        self.detector_calls = 0
        self.confirm_calls = 0
        self.last_confirm_t = -1e18
        self.rejected: list[list] = []  # [label, box, until, misses]
        self.empty_since: float | None = None  # since when the detector has seen no candidate in a moving picture
        self.busy = False  # was the picture moving at the last decision
        self.started: float | None = None
        self.last_frame: np.ndarray | None = None
        self.last_frame_t = 0.0
        self.loudness = -120.0
        self.last_sound_scores: dict[str, float] = {}
        self.spans = Spans(account_id, source_id)

    @property
    def _key(self) -> str:
        return f"{self.account_id}.{self.source_id}"

    def _ids(self) -> dict:
        return {"account_id": self.account_id, "source_id": self.source_id}

    def on_frame(self, rgb: np.ndarray, t: float) -> list[tuple[str, dict]]:
        self.frame_no += 1
        self.last_frame, self.last_frame_t = rgb, t
        if self.started is None:
            self.started = t
        with child_span("brain.signal") as span:
            motion = self.motion.update(rgb)
            span.set_attribute("senseplane.motion", round(float(motion), 4))
        out: list[tuple[str, dict]] = []
        if self.detector and self._detect_due(motion, t):
            self.last_detect_t = t
            self.detector_calls += 1
            with child_span("brain.detect") as span:
                dets, confirmed = self._detect(rgb, t)
                span.set_attribute("senseplane.detections", len(dets))
                span.set_attribute("senseplane.confirmed", confirmed)
            with child_span("brain.track") as span:
                self.tracker.update(dets, t)
                span.set_attribute("senseplane.tracks", len(self.tracker.active))
            if confirmed:
                for track in self.tracker.tracks:
                    if track.last_seen == t:
                        track.verified_score = max(track.verified_score, track.score)
            for track in self.tracker.active:
                if track.last_seen == t and self._event_score(track) >= EVENT_MIN_SCORE[track.label]:
                    out += self._on_confirmed(track, rgb, t)
            out += self._presence(t)
        if self.episode and any(not tr.stationary for tr in self.tracker.active):
            self.episode.last_active = t
            active = {tr.label for tr in self.tracker.active if not tr.stationary}
            for label, key in self.episode.labels.items():
                if label in active:
                    self.markers.hold(f"episode:{self._key}:{label}", EPISODE_MARK_S, t, key)
        with child_span("brain.episode") as span:
            out += self.tick(t)
            span.set_attribute("senseplane.events", len(out))
        return out

    def _presence(self, t: float) -> list[tuple[str, dict]]:
        """Presence activities: each label in view, and in each zone, while a track that scores high enough
        to post events is there (stationary ones too: someone sitting at a table is present)."""
        here: dict[tuple[str, str | None], list[float]] = {}
        for tr in self.tracker.active:
            if tr.label not in labels.EVENTS or t - tr.last_seen > 1.0 or self._event_score(tr) < EVENT_MIN_SCORE[tr.label]:
                continue
            for zone in [None, *zones_for(tr.box, self.w, self.h, self.zones)]:
                here.setdefault((tr.label, zone), []).append(tr.best_score)
        out = []
        for (label, zone), scores in here.items():
            gap = PRESENCE_GAP_S["group" if label in labels.GROUPS else "object"]
            out += self.spans.seen("presence", label, zone, t, gap, count=len(scores), confidence=max(scores))
        return out

    def _event_score(self, track: Track) -> float:
        return track.verified_score if self.confirm else track.best_score

    def _settled(self, d, t: float) -> bool:
        """Is this detection a track the confirm detector already scored high enough?"""
        return any(tr.label == d.label and tr.verified_score >= EVENT_MIN_SCORE[tr.label] and iou(tr.predicted(t), d.box) >= 0.25
                   for tr in self.tracker.tracks)

    def _rejected_at(self, d, t: float) -> bool:
        need = self.cfg.reject_group_misses if d.label in labels.GROUPS else 1
        return any(r[0] == d.label and r[2] > t and r[3] >= need and iou(r[1], d.box) >= 0.5 for r in self.rejected)

    def _detect(self, rgb: np.ndarray, t: float):
        """The frame's detections, and whether the confirm detector produced them (see Config, cascade)."""
        found = self.detector.detect(rgb)
        if self.confirm:
            self.rejected = [r for r in self.rejected if r[2] > t]
            found = [d for d in found if not self._rejected_at(d, t)]
        if not self.busy or any(d.score >= self.cfg.candidate_score for d in found):
            self.empty_since = None
        elif self.empty_since is None:
            self.empty_since = t
        if not self.confirm:
            return found, False
        new = [d for d in found if d.score >= self.cfg.candidate_score and d.label in labels.EVENTS and not self._settled(d, t)]
        if not new or t - self.last_confirm_t < self.cfg.confirm_every_s - 1e-6:
            return found, False
        self.last_confirm_t = t
        self.confirm_calls += 1
        with child_span("brain.confirm"):
            sure = self.confirm.detect(rgb)
        for d in new:
            if any(s.label == d.label and iou(s.box, d.box) >= 0.3 for s in sure):
                continue
            seen = next((r for r in self.rejected if r[0] == d.label and iou(r[1], d.box) >= 0.5), None)
            if seen:
                seen[1], seen[2], seen[3] = d.box, t + self.cfg.reject_s, seen[3] + 1
            else:
                self.rejected.append([d.label, d.box, t + self.cfg.reject_s, 1])
        return sure, True

    def _detect_due(self, motion: float, t: float) -> bool:
        busy = any(not tr.stationary for tr in self.tracker.tracks) or motion >= self.cfg.motion_gate
        self.busy = busy
        if not self.cfg.adaptive:
            busy = any(not tr.stationary for tr in self.tracker.active) or motion >= self.cfg.motion_gate
            return busy or self.frame_no % self.cfg.idle_detect_every == 1
        if busy:
            if not self.tracker.tracks and self.empty_since is not None and t - self.empty_since >= self.cfg.empty_motion_after_s:
                return t - self.last_detect_t >= self.cfg.empty_motion_detect_s - 1e-6
            return not self._only_tracked_motion(t) or t - self.last_detect_t >= self.cfg.tracked_detect_s - 1e-6
        if not self.tracker.tracks:
            every = self.cfg.empty_quiet_detect_s if motion >= self.cfg.still_motion else self.cfg.empty_still_detect_s
            return t - self.last_detect_t >= every - 1e-6
        every = self.cfg.quiet_detect_s if motion >= self.cfg.still_motion else self.cfg.still_detect_s
        # A picture with live tracks (a person standing still at the door) is looked at well within the
        # tracker's max age: a gap longer than that would end the track, which reads as "left".
        if self.tracker.tracks:
            every = min(every, self.cfg.quiet_detect_s)
        return t - self.last_detect_t >= every - 1e-6

    def _only_tracked_motion(self, t: float) -> bool:
        """Is all the movement in the picture inside boxes the tracker already follows?"""
        tracks = self.tracker.tracks
        if not tracks or any(not tr.confirmed or t - tr.first_seen < self.cfg.new_track_s for tr in tracks):
            return False
        mask = self.motion.last_mask
        if mask is None:
            return True
        mh, mw = mask.shape
        outside = mask.copy()
        for tr in tracks:
            x1, y1, x2, y2 = tr.predicted(t)
            # A margin of a tenth of the box: a moving person's limbs stick out of last frame's box.
            mx, my = (x2 - x1) * 0.1, (y2 - y1) * 0.1
            outside[max(0, int((y1 - my) * mh / self.h)):int((y2 + my) * mh / self.h) + 1,
                    max(0, int((x1 - mx) * mw / self.w)):int((x2 + mx) * mw / self.w) + 1] = False
        return float(outside.mean()) < self.cfg.motion_gate

    def _quiet_object(self, track: Track, t: float) -> bool:
        """An everyday object that should not post an event now (see Config)."""
        if track.label in labels.GROUPS:
            return False
        if self.started is not None and track.first_seen - self.started < self.cfg.object_warmup_s:
            return True
        # Claimed here, right before the event is built: the object cooldown is shared across brains.
        return not self.markers.claim(f"object:{self._key}:{track.label}", self.cfg.object_event_cooldown_s, t)

    def _on_confirmed(self, track: Track, rgb: np.ndarray, t: float) -> list[tuple[str, dict]]:
        if track.stationary or track.label not in labels.EVENTS:
            return []
        mark = f"episode:{self._key}:{track.label}"
        if self.episode is None or track.label not in self.episode.labels:
            # Announced by the brain this camera had before (a handover): this episode carries it on, silently.
            earlier = self.markers.value(mark, t)
            if earlier is not None:
                if self.episode is None:
                    self.episode = Episode(uuid.uuid4().hex[:12], t, t)
                self.episode.labels[track.label] = earlier
                self.episode.last_active = t
                return []
            if self._quiet_object(track, t):
                return []
        if self.episode is None:
            self.episode = Episode(uuid.uuid4().hex[:12], t, t)
        ep = self.episode
        ep.last_active = t
        if track.label in ep.labels:
            return []  # one event per label per episode
        key = f"{ep.id}:{track.label}"
        ep.labels[track.label] = key
        self.markers.hold(mark, EPISODE_MARK_S, t, key)
        zones = zones_for(track.box, self.w, self.h, self.zones)
        where = f" in {', '.join(z.replace('_', ' ') for z in zones)}" if zones else ""
        return [("brain.event", {
            "event_key": key, **self._ids(), "type": f"detection.{track.label}", "occurred_at": iso(track.first_seen),
            "labels": [track.label], "confidence": round(track.best_score, 3), "zones": zones,
            "summary": f"{labels.phrase(track.label)} was seen{where}.", "snapshot_jpeg_b64": self._snapshot(rgb, track.box),
        })]

    def _snapshot(self, rgb: np.ndarray, box=None) -> str:
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        if box is not None:
            x1, y1, x2, y2 = (int(v) for v in box)
            cv2.rectangle(bgr, (x1, y1), (x2, y2), (40, 200, 255), 2)
        ok, jpg = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return base64.b64encode(jpg.tobytes()).decode() if ok else ""

    def latest_jpeg(self) -> bytes | None:
        return base64.b64decode(self._snapshot(self.last_frame)) if self.last_frame is not None else None

    def tick(self, t: float) -> list[tuple[str, dict]]:
        out = self.spans.tick(t)
        ep = self.episode
        if ep and t - ep.last_active > self.cfg.episode_grace_s:
            self.episode = None
            for label in ep.labels:
                self.markers.release(f"episode:{self._key}:{label}")
            out += [("brain.episode.closed", {"event_key": k, **self._ids(), "ended_at": iso(ep.last_active)}) for k in ep.labels.values()]
        return out

    def on_audio(self, samples: np.ndarray, t: float) -> list[tuple[str, dict]]:
        self.loudness = loudness_dbfs(samples)
        if not self.sound or self.loudness < -60:
            self.last_sound_scores = {}
            return []
        out = []
        self.last_sound_scores = self.sound.classify(samples)
        for cls, score in self.last_sound_scores.items():
            if cls in SOUND_THRESHOLDS and score >= SOUND_THRESHOLDS[cls]:
                out += self.spans.seen("sound", cls, None, t, SOUND_GAP_S, confidence=score)
            if cls not in self.cfg.sound_events or score < SOUND_THRESHOLDS[cls]:
                continue
            if not self.markers.claim(f"sound:{self._key}:{cls}", self.cfg.sound_cooldown_s, t):
                continue
            out.append(("brain.event", {
                "event_key": f"snd:{self.source_id}:{cls}:{int(t)}", **self._ids(), "type": "sound.detected", "occurred_at": iso(t),
                "labels": [cls], "confidence": round(score, 3), "summary": f"Heard {SOUND_TEXT[cls]}.",
            }))
        return out
