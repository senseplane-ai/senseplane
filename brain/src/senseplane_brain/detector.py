# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Stage 2, perception: YOLOX (Apache 2.0) through ONNX Runtime."""

import os

import cv2
import numpy as np
import onnxruntime as ort

from . import models
from .labels import COCO

# COCO class index → Senseplane label (spec/labels.json): person (0); vehicle = bicycle, car,
# motorcycle, bus, truck; animal = bird … giraffe (14-23); every other class is its own label.
LABELS: dict[int, str] = COCO


class Detection(tuple):
    __slots__ = ()

    def __new__(cls, label: str, score: float, box: tuple[float, float, float, float]):
        return super().__new__(cls, (label, score, box))

    label = property(lambda s: s[0])
    score = property(lambda s: s[1])
    box = property(lambda s: s[2])  # x1, y1, x2, y2 in frame pixels


# The int8 build looks at every frame due; yolox_s confirms what it sees new before any event (pipeline cascade).
DEFAULT_MODEL = "yolox_s_int8"
DEFAULT_CONFIRM_MODEL = "yolox_s"


# In a cascade the cheap detector reports weaker candidates too: a person half in the frame scores low on
# the int8 build, and only the confirm detector's scores decide events.
FINDER_SCORE = 0.25


def detectors(model: str | None = None, confirm: str | None = None) -> "tuple[YoloxDetector, YoloxDetector | None]":
    """The detector and the cascade's confirm detector (DETECTOR_MODEL, DETECTOR_CONFIRM_MODEL); no confirm
    detector when it is "none" or the detector itself."""
    model = model or os.environ.get("DETECTOR_MODEL", DEFAULT_MODEL)
    confirm = confirm if confirm is not None else os.environ.get("DETECTOR_CONFIRM_MODEL", DEFAULT_CONFIRM_MODEL)
    if confirm in ("", "none") or confirm == model:
        return YoloxDetector(model), None
    return YoloxDetector(model, score_threshold=FINDER_SCORE), YoloxDetector(confirm)


class YoloxDetector:
    def __init__(self, model: str | None = None, score_threshold: float = 0.4, nms_threshold: float = 0.45):
        model = model or os.environ.get("DETECTOR_MODEL", DEFAULT_MODEL)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = int(os.environ.get("DETECTOR_THREADS", "2"))
        self.session = ort.InferenceSession(str(models.fetch(model)), opts, providers=["CPUExecutionProvider"])
        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        self.size = int(inp.shape[2])
        self.score_threshold = score_threshold
        self.nms_threshold = nms_threshold
        self.grids, self.strides = self._grids(self.size)

    @staticmethod
    def _grids(size: int):
        grids, strides = [], []
        for stride in (8, 16, 32):
            n = size // stride
            xv, yv = np.meshgrid(np.arange(n), np.arange(n))
            grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
            strides.append(np.full((n * n, 1), stride))
        return np.concatenate(grids).astype(np.float32), np.concatenate(strides).astype(np.float32)

    def detect(self, rgb: np.ndarray) -> list[Detection]:
        h, w = rgb.shape[:2]
        ratio = min(self.size / h, self.size / w)
        resized = cv2.resize(rgb, (int(w * ratio), int(h * ratio)), interpolation=cv2.INTER_LINEAR)
        padded = np.full((self.size, self.size, 3), 114, dtype=np.uint8)
        padded[: resized.shape[0], : resized.shape[1]] = resized
        blob = np.ascontiguousarray(padded[:, :, ::-1].transpose(2, 0, 1), dtype=np.float32)[None]  # YOLOX expects BGR, 0-255
        out = self.session.run(None, {self.input_name: blob})[0][0]
        out[:, :2] = (out[:, :2] + self.grids) * self.strides
        out[:, 2:4] = np.exp(out[:, 2:4]) * self.strides
        scores = out[:, 4:5] * out[:, 5:]
        cls = scores.argmax(1)
        conf = scores[np.arange(len(cls)), cls]
        keep = (conf >= self.score_threshold) & np.isin(cls, list(LABELS))
        if not keep.any():
            return []
        b, conf, cls = out[keep, :4], conf[keep], cls[keep]
        xyxy = np.stack([b[:, 0] - b[:, 2] / 2, b[:, 1] - b[:, 3] / 2, b[:, 0] + b[:, 2] / 2, b[:, 1] + b[:, 3] / 2], 1) / ratio
        labels = np.array([LABELS[int(c)] for c in cls])
        result: list[Detection] = []
        for label in set(labels.tolist()):
            idx = np.where(labels == label)[0]
            boxes = [[float(x1), float(y1), float(x2 - x1), float(y2 - y1)] for x1, y1, x2, y2 in xyxy[idx]]
            kept = cv2.dnn.NMSBoxes(boxes, conf[idx].tolist(), self.score_threshold, self.nms_threshold)
            for k in np.array(kept).flatten():
                x1, y1, x2, y2 = xyxy[idx[k]]
                result.append(Detection(label, float(conf[idx[k]]), (max(0.0, float(x1)), max(0.0, float(y1)), min(float(w), float(x2)), min(float(h), float(y2)))))
        return result
