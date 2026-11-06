# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Sounds heard over time: a camera's telephone-band microphone makes YAMNet less sure, so crying
counts when it keeps going and a dog only when it keeps barking (the scores below are from a G.711
baby camera, 2026-11-06)."""

import numpy as np

from senseplane_brain.pipeline import SourcePipeline

T0 = 1_000_000.0
LOUD = np.full(16000, 0.1, dtype=np.float32)  # -20 dBFS: above the silence gate


class Scripted:
    """A SoundClassifier that returns the next scripted scores."""

    def __init__(self, scores):
        self.scores = iter(scores)

    def classify(self, _samples):
        return {"crying": 0.0, "dog": 0.0, "glass_break": 0.0, "alarm": 0.0, "speech_present": 0.0, **next(self.scores)}


def heard(seconds):
    p = SourcePipeline("acc", "src", None, Scripted(seconds))
    out = []
    for i in range(len(seconds)):
        out += [pl["labels"][0] for kind, pl in p.on_audio(LOUD, T0 + i) if kind == "brain.event"]
    return out


def test_a_baby_crying_softly_for_seconds_counts_as_crying():
    # Through a camera microphone the cry scores 0.15 to 0.33: never one confident second.
    assert heard([{"crying": x} for x in (0.2, 0.26, 0.15, 0.33, 0.2)]) == ["crying"]


def test_one_soft_second_is_not_crying():
    assert heard([{"crying": 0.3}, {}, {}, {"crying": 0.2}, {}]) == []


def test_a_confident_cry_still_counts_at_once():
    assert heard([{"crying": 0.59}]) == ["crying"]


def test_a_babys_coo_that_scores_dog_for_a_second_or_two_is_not_a_dog():
    # Two seconds of "dog" (0.67, 0.74), then quiet, then a single 0.5 well after: as it happened.
    assert heard([{}, {"dog": 0.67}, {"dog": 0.74}] + [{}] * 10 + [{"dog": 0.5}, {}]) == []


def test_a_dog_that_keeps_barking_is_a_dog():
    assert heard([{"dog": 0.8}, {}, {"dog": 0.6}, {"dog": 0.7}, {"dog": 0.9}]) == ["dog"]
