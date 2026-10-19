# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Runs the pipeline over a video file (same 640x360 box and 5 fps as the media
analysis feed). Used by tests and to tune thresholds without the full stack."""

import subprocess

import numpy as np

from .pipeline import SourcePipeline

W, H, FPS = 640, 360, 5


def decode(path: str) -> tuple[np.ndarray, np.ndarray]:
    """Frames (n, 360, 640, 3) at 5 fps and 16 kHz mono PCM, like the media analysis feed."""
    vf = f"fps={FPS},scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,format=rgb24"
    video = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vf", vf, "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    audio = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], capture_output=True).stdout
    return np.frombuffer(video, dtype=np.uint8).reshape(-1, H, W, 3), np.frombuffer(audio, dtype=np.float32)


def run_file(path: str, pipeline: SourcePipeline, t0: float = 1_000_000.0, after_frame=None) -> list[tuple[float, str, dict]]:
    """after_frame(pipeline, frame, t) runs after each frame (e.g. the watch engine)."""
    frames, pcm = decode(path)
    out: list[tuple[float, str, dict]] = []
    next_audio = 0
    for i, frame in enumerate(frames):
        t = i / FPS
        while next_audio + 16000 <= pcm.size and next_audio / 16000 <= t:
            out += [(t, s, p) for s, p in pipeline.on_audio(pcm[next_audio:next_audio + 16000], t0 + next_audio / 16000)]
            next_audio += 16000
        out += [(t, s, p) for s, p in pipeline.on_frame(frame, t0 + t)]
        if after_frame:
            after_frame(pipeline, frame, t0 + t)
    end = len(frames) / FPS
    out += [(end + 10, s, p) for s, p in pipeline.tick(t0 + end + 10)]
    out += [(end + 60, s, p) for s, p in pipeline.tick(t0 + end + 60)]  # activities end after their gap (ADR 0057)
    return out

