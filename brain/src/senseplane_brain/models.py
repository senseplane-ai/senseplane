# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Pinned, checksummed model artefacts. Nothing is bundled in git: `fetch()`
downloads each file once into SENSEPLANE_MODELS_DIR and refuses a mismatch.
Licences are recorded in NOTICE."""

import hashlib
import io
import os
import tarfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

MODELS_DIR = Path(os.environ.get("SENSEPLANE_MODELS_DIR", Path(__file__).resolve().parents[2] / "models"))


@dataclass(frozen=True)
class Artefact:
    name: str
    url: str
    sha256: str  # of the downloaded file
    licence: str
    extract: str | None = None  # member to extract from a .tar.gz
    derived_from: str | None = None  # built locally from this artefact instead of downloaded


ARTEFACTS = {
    # YOLOX (Megvii, Apache 2.0): official ONNX exports, COCO 80 classes.
    "yolox_s": Artefact("yolox_s.onnx", "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_s.onnx",
                        "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063", "Apache-2.0"),
    # Built here from yolox_s, not downloaded (senseplane_brain.quantize): int8, about 3x less CPU per frame.
    "yolox_s_int8": Artefact("yolox_s_int8.onnx", "", "", "Apache-2.0", derived_from="yolox_s"),
    "yolox_tiny": Artefact("yolox_tiny.onnx", "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx",
                           "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7", "Apache-2.0"),
    # YAMNet (Google, Apache 2.0): TFLite classifier, AudioSet 521 classes.
    "yamnet": Artefact("yamnet.tflite", "https://www.kaggle.com/api/v1/models/google/yamnet/tfLite/classification-tflite/1/download",
                       "1b971b2132760273a5fb8f5dc504e86783b27853bb3135d555ae06f1e1e365f3", "Apache-2.0", extract="1.tflite"),
    "yamnet_classes": Artefact("yamnet_class_map.csv",
                               "https://raw.githubusercontent.com/tensorflow/models/dfffd623b6be8d1d9744b8e261fbac370d17c46d/research/audioset/yamnet/yamnet_class_map.csv",
                               "cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2", "Apache-2.0"),
    # all-MiniLM-L6-v2 (sentence-transformers, Apache 2.0), int8 ONNX export by Xenova, pinned revision.
    "minilm": Artefact("minilm-l6-v2-int8.onnx",
                       "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/onnx/model_quantized.onnx",
                       "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1", "Apache-2.0"),
    "minilm_tokenizer": Artefact("minilm-l6-v2-tokenizer.json",
                                 "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/tokenizer.json",
                                 "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0", "Apache-2.0"),
}


def path(key: str) -> Path:
    return MODELS_DIR / ARTEFACTS[key].name


def fetch(key: str) -> Path:
    art = ARTEFACTS[key]
    dest = MODELS_DIR / art.name
    if dest.exists():
        return dest
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    if art.derived_from:
        from .quantize import build_int8

        build_int8(fetch(art.derived_from), dest)
        return dest
    req = urllib.request.Request(art.url, headers={"User-Agent": "senseplane-brain"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = resp.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != art.sha256:
        raise RuntimeError(f"{key}: checksum mismatch (got {digest}, want {art.sha256}); refusing to use it")
    if art.extract:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
            member = tar.extractfile(art.extract)
            if member is None:
                raise RuntimeError(f"{key}: {art.extract} missing from archive")
            data = member.read()
    tmp = dest.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(dest)
    return dest


def fetch_all() -> None:
    for key in ARTEFACTS:
        print(f"{key}: {fetch(key)}")
