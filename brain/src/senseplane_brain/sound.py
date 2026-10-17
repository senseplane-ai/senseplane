# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Stage 2, sound: YAMNet (Apache 2.0) on 0.975 s windows at 16 kHz.
Detection only: class scores, never speech content."""

import csv

import numpy as np
from ai_edge_litert.interpreter import Interpreter

from . import models

# Senseplane sound class → YAMNet display names that count for it.
CLASSES: dict[str, set[str]] = {
    "crying": {"Baby cry, infant cry", "Crying, sobbing", "Whimper"},
    "glass_break": {"Glass", "Shatter", "Breaking"},
    "alarm": {"Alarm", "Smoke detector, smoke alarm", "Fire alarm", "Siren", "Car alarm", "Buzzer", "Alarm clock"},
    "dog": {"Dog", "Bark", "Yip", "Howl", "Bow-wow", "Growling", "Whimper (dog)"},
    "speech_present": {"Speech", "Conversation", "Narration, monologue"},
}
WINDOW = 15600


class SoundClassifier:
    def __init__(self):
        self.interpreter = Interpreter(model_path=str(models.fetch("yamnet")))
        self.input = self.interpreter.get_input_details()[0]
        self.output = self.interpreter.get_output_details()[0]
        with open(models.fetch("yamnet_classes"), newline="") as f:
            names = [row["display_name"] for row in csv.DictReader(f)]
        self.index = {cls: [i for i, n in enumerate(names) if n in wanted] for cls, wanted in CLASSES.items()}

    def classify(self, samples: np.ndarray) -> dict[str, float]:
        """Scores per Senseplane class for one window (samples float32, 16 kHz mono)."""
        window = np.zeros(WINDOW, dtype=np.float32)
        window[: min(WINDOW, samples.size)] = samples[:WINDOW]
        self.interpreter.resize_tensor_input(self.input["index"], [WINDOW], strict=False)
        self.interpreter.allocate_tensors()
        self.interpreter.set_tensor(self.input["index"], window)
        self.interpreter.invoke()
        scores = self.interpreter.get_tensor(self.output["index"]).reshape(-1, 521).max(0)
        return {cls: float(scores[idx].max()) if idx else 0.0 for cls, idx in self.index.items()}
