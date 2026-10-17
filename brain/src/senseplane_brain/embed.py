# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Text embeddings for memory search: all-MiniLM-L6-v2 (int8 ONNX), 384 dims,
mean-pooled and L2-normalised. Local, so search needs no external call."""

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

from . import models

MODEL_NAME = "all-MiniLM-L6-v2-int8"
DIMS = 384


class Embedder:
    def __init__(self):
        self.tokenizer = Tokenizer.from_file(str(models.fetch("minilm_tokenizer")))
        self.tokenizer.enable_truncation(max_length=128)
        self.tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        self.session = ort.InferenceSession(str(models.fetch("minilm")), opts, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.session.get_inputs()}

    def embed(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, DIMS), dtype=np.float32)
        enc = self.tokenizer.encode_batch(texts)
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.zeros_like(ids)
        hidden = self.session.run(None, feed)[0]
        m = mask[..., None].astype(np.float32)
        pooled = (hidden * m).sum(1) / np.clip(m.sum(1), 1e-9, None)
        return (pooled / np.linalg.norm(pooled, axis=1, keepdims=True)).astype(np.float32)
