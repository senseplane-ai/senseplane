# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Has the camera's view changed since its privacy masks were drawn?

Masks are polygons in normalized coordinates, so if a camera is moved,
zoomed or switches aspect ratio they cover the wrong part of the picture.
The reference view is a small normalized grayscale thumbnail taken when the
masks change; every check compares the current frame with it by correlation
(robust to light level and exposure). A drop below the threshold for several
checks in a row raises `source.view_changed` once.
"""

from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass

import numpy as np

THUMB_W, THUMB_H = 32, 18
CHECK_EVERY_S = 30.0
MIN_CORRELATION = 0.5
CHECKS_IN_A_ROW = 3


def thumbnail(rgb: np.ndarray) -> np.ndarray:
    gray = rgb.astype(np.float32).mean(axis=2)
    h, w = gray.shape
    ys = (np.arange(THUMB_H + 1) * h // THUMB_H).astype(int)
    xs = (np.arange(THUMB_W + 1) * w // THUMB_W).astype(int)
    t = np.array([[gray[ys[i]:ys[i + 1], xs[j]:xs[j + 1]].mean() for j in range(THUMB_W)] for i in range(THUMB_H)], dtype=np.float32)
    return t


def correlation(a: np.ndarray, b: np.ndarray, ignore: np.ndarray | None = None) -> float:
    m = np.ones_like(a, dtype=bool) if ignore is None else ~ignore
    x, y = a[m] - a[m].mean(), b[m] - b[m].mean()
    d = float(np.sqrt((x * x).sum() * (y * y).sum()))
    return float((x * y).sum() / d) if d > 1e-6 else 1.0


def masks_signature(masks: list) -> str:
    return hashlib.sha256(json.dumps(masks, sort_keys=True).encode()).hexdigest()[:16]


@dataclass
class Reference:
    thumb: np.ndarray
    width: int
    height: int
    masks: str
    flagged: bool = False

    def dump(self) -> bytes:
        return json.dumps({"thumb": base64.b64encode(np.clip(self.thumb, 0, 255).astype(np.uint8).tobytes()).decode(),
                           "width": self.width, "height": self.height, "masks": self.masks, "flagged": self.flagged}).encode()

    @staticmethod
    def load(raw: bytes) -> Reference:
        d = json.loads(raw)
        t = np.frombuffer(base64.b64decode(d["thumb"]), dtype=np.uint8).astype(np.float32).reshape(THUMB_H, THUMB_W)
        return Reference(t, d["width"], d["height"], d["masks"], d.get("flagged", False))


class ViewMonitor:
    """One per source. check() returns (changed_now, reference_to_store | None)."""

    def __init__(self, reference: Reference | None = None):
        self.ref = reference
        self.last_check = 0.0
        self.misses = 0

    def check(self, rgb: np.ndarray, masks: list, t: float) -> tuple[bool, Reference | None]:
        if not masks:
            return False, None
        sig = masks_signature(masks)
        h, w = rgb.shape[:2]
        if self.ref is None or self.ref.masks != sig:
            # New or changed masks: this frame is the view they were drawn on.
            self.ref, self.misses, self.last_check = Reference(thumbnail(rgb), w, h, sig), 0, t
            return False, self.ref
        if t - self.last_check < CHECK_EVERY_S:
            return False, None
        self.last_check = t
        if (w, h) != (self.ref.width, self.ref.height):
            self.misses = CHECKS_IN_A_ROW
        else:
            black = self.ref.thumb < 2  # masked areas are black in both; leave them out
            self.misses = self.misses + 1 if correlation(self.ref.thumb, thumbnail(rgb), black) < MIN_CORRELATION else 0
        if self.misses >= CHECKS_IN_A_ROW and not self.ref.flagged:
            self.ref.flagged = True
            return True, self.ref
        if self.misses == 0 and self.ref.flagged:
            self.ref.flagged = False  # back to the original view
            return False, self.ref
        return False, None
