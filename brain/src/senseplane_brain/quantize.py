# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Builds the int8 detector from the official YOLOX export (docs/milestones/brain-tuning.md).

Static QDQ quantization, per-channel int8 weights, calibrated on pinned COCO
val2017 photos letterboxed as the frames feed sends them. About 3x less CPU per
frame than yolox_s. Runs once, at image build (scripts/fetch_models.py); needs
the `quantize` dependency group (onnx, sympy), which the image drops again."""

import hashlib
import tempfile
import urllib.request
from pathlib import Path

import cv2
import numpy as np

# COCO val2017 ids used only to calibrate (never shipped); their bytes, in this order, hash to CALIBRATION_SHA256.
CALIBRATION_IDS = (
    139, 285, 632, 724, 776, 785, 802, 872, 885, 1000, 1268, 1296, 1353, 1425, 1490, 1503, 1532, 1584, 1675, 1761,
    1818, 1993, 2006, 2149, 2153, 2157, 2261, 2299, 2431, 2473, 2532, 2587, 2592, 2685, 2923, 3156, 3255, 3501, 3553,
    3661, 3845, 3934, 4134, 4395, 4495, 4765, 4795, 5001, 5037, 5060, 5193, 5477, 5503, 5529, 5586, 5600, 5992, 6012,
    6040, 6213, 6460, 6471, 6614, 6723, 6763, 6771, 6818, 6894, 6954, 7088, 7108, 7278, 7281, 7386, 7511, 7574, 7784,
    7795, 7816, 7818, 7888, 7977, 7991, 8021, 8211, 8277, 8532, 8629, 8690, 8762, 8844, 8899, 9378, 9400, 9448, 9483,
    9590, 9769, 9772, 9891,
)
CALIBRATION_SHA256 = "54f0260cbfa5304cf407d9377381ec62a348cf3e2ae5e51f9baf36749918714e"
CALIBRATION_URL = "http://images.cocodataset.org/val2017/{:012d}.jpg"


def _calibration_images() -> list[bytes]:
    out = []
    for i in CALIBRATION_IDS:
        req = urllib.request.Request(CALIBRATION_URL.format(i), headers={"User-Agent": "senseplane-brain"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            out.append(resp.read())
    digest = hashlib.sha256(b"".join(out)).hexdigest()
    if digest != CALIBRATION_SHA256:
        raise RuntimeError(f"calibration images: checksum mismatch (got {digest}); refusing to quantize")
    return out


def _as_feed_frame(jpeg: bytes) -> np.ndarray:
    """A photo letterboxed into 640x360, as the media plane's frames feed sends it, then the detector's input."""
    bgr = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    h, w = bgr.shape[:2]
    r = min(640 / w, 360 / h)
    small = cv2.resize(bgr, (int(w * r), int(h * r)))
    frame = np.zeros((360, 640, 3), np.uint8)
    y, x = (360 - small.shape[0]) // 2, (640 - small.shape[1]) // 2
    frame[y:y + small.shape[0], x:x + small.shape[1]] = small
    padded = np.full((640, 640, 3), 114, np.uint8)  # YoloxDetector pads the 640x360 frame to a 640 square
    padded[:360] = frame
    return np.ascontiguousarray(padded.transpose(2, 0, 1), dtype=np.float32)[None]  # BGR, 0-255, as YoloxDetector


def build_int8(src: Path, dest: Path) -> None:
    import onnx
    from onnx import version_converter
    from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
    from onnxruntime.quantization.shape_inference import quant_pre_process

    frames = [_as_feed_frame(b) for b in _calibration_images()]

    class Reader(CalibrationDataReader):
        def __init__(self):
            self.it = iter(frames)

        def get_next(self):
            x = next(self.it, None)
            return None if x is None else {"images": x}

    with tempfile.TemporaryDirectory() as tmp:
        op13, pre = Path(tmp) / "op13.onnx", Path(tmp) / "pre.onnx"
        # The export is opset 11; per-channel DequantizeLinear needs 13.
        onnx.save(version_converter.convert_version(onnx.load(str(src)), 13), str(op13))
        quant_pre_process(str(op13), str(pre))
        part = dest.with_suffix(".part")
        quantize_static(str(pre), str(part), Reader(), quant_format=QuantFormat.QDQ, per_channel=True,
                        activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8)
        part.replace(dest)
