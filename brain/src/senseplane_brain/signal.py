# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Stage 1, signal: cheap motion and loudness on every frame and audio chunk."""

import cv2
import numpy as np


class MotionDetector:
    """Running-average background on a small grey frame.

    A sudden change over most of the frame (lights switching on, an IR mode
    flip, auto-exposure) is treated as a lighting change: the background is
    reset and that frame reports no motion, instead of a burst of false motion.
    """

    def __init__(self, width: int = 160, height: int = 90, alpha: float = 0.05, threshold: int = 25, lighting_fraction: float = 0.6):
        self.size = (width, height)
        self.alpha = alpha
        self.threshold = threshold
        self.lighting_fraction = lighting_fraction
        self.background: np.ndarray | None = None
        self.lighting_changes = 0
        self.last_mask: np.ndarray | None = None  # moving pixels of the last frame (height × width bool)

    def update(self, rgb: np.ndarray) -> float:
        """Returns the fraction of the frame that moved (0..1)."""
        grey = cv2.cvtColor(cv2.resize(rgb, self.size, interpolation=cv2.INTER_AREA), cv2.COLOR_RGB2GRAY)
        grey = cv2.GaussianBlur(grey, (5, 5), 0).astype(np.float32)
        if self.background is None:
            self.background = grey
            self.last_mask = np.zeros(grey.shape, dtype=bool)
            return 0.0
        diff = cv2.absdiff(grey, self.background)
        moving = diff > self.threshold
        fraction = float(moving.mean())
        if fraction > self.lighting_fraction:
            self.background = grey
            self.lighting_changes += 1
            self.last_mask = np.zeros(grey.shape, dtype=bool)
            return 0.0
        cv2.accumulateWeighted(grey, self.background, self.alpha)
        mask = cv2.dilate(moving.astype(np.uint8), np.ones((3, 3), np.uint8))
        self.last_mask = mask.astype(bool)
        return float(mask.mean())


def loudness_dbfs(samples: np.ndarray) -> float:
    """RMS level of float samples in dBFS (silence is -inf, clamped to -120)."""
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64)))) if samples.size else 0.0
    return max(20.0 * np.log10(rms), -120.0) if rms > 0 else -120.0
