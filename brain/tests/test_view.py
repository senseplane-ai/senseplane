# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
import numpy as np

from senseplane_brain.view import CHECK_EVERY_S, Reference, ViewMonitor

MASK = [[[0, 0], [0.3, 0], [0.3, 1], [0, 1]]]


def scene(seed: int, w=640, h=360, gain=1.0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    base = rng.integers(0, 255, size=(9, 16, 3)).astype(np.float32)
    img = np.kron(base, np.ones((h // 9, w // 16, 1))) * gain
    img[:, : int(w * 0.3)] = 0  # masked region
    return np.clip(img, 0, 255).astype(np.uint8)


def run(m: ViewMonitor, frame, start: float, n: int):
    hits = []
    for i in range(n):
        changed, _ = m.check(frame, MASK, start + i * CHECK_EVERY_S)
        hits.append(changed)
    return hits


def test_same_view_in_other_light_never_flags():
    m = ViewMonitor()
    m.check(scene(1), MASK, 0)
    assert not any(run(m, scene(1, gain=0.4), CHECK_EVERY_S, 6))


def test_moved_camera_flags_once_after_three_checks():
    m = ViewMonitor()
    m.check(scene(1), MASK, 0)
    hits = run(m, scene(2), CHECK_EVERY_S, 6)
    assert hits == [False, False, True, False, False, False]


def test_new_aspect_ratio_flags_and_new_masks_reset():
    m = ViewMonitor()
    m.check(scene(1), MASK, 0)
    assert m.check(scene(1, w=360, h=640), MASK, CHECK_EVERY_S)[0] is True
    changed, ref = m.check(scene(1, w=360, h=640), [[[0, 0], [0.5, 0], [0.5, 1]]], 2 * CHECK_EVERY_S)
    assert changed is False and ref is not None and not ref.flagged


def test_reference_round_trips():
    m = ViewMonitor()
    _, ref = m.check(scene(3), MASK, 0)
    again = Reference.load(ref.dump())
    assert again.masks == ref.masks and again.thumb.shape == (18, 32)
