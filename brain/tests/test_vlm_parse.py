# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Model replies parsed as JSON, however they arrive."""

from senseplane_brain.vlm import _parse_json


def test_takes_the_first_object_when_a_model_sends_two():
    reply = '{"yes": false, "answer": "No parcel.", "confidence": 0.9}\n\n{"yes": true, "answer": "A parcel.", "confidence": 0.5}'
    assert _parse_json(reply) == {"yes": False, "answer": "No parcel.", "confidence": 0.9}


def test_skips_prose_and_code_fences():
    assert _parse_json('Here you go:\n```json\n{"yes": true, "answer": "A dog.", "confidence": 0.8}\n```') == {"yes": True, "answer": "A dog.", "confidence": 0.8}
    assert _parse_json('{"a": {"b": "}"}}') == {"a": {"b": "}"}}
