// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audioTrackIds, stripAudioInit, stripTracksFromSegment } from "./fmp4.js";

const ffmpegAvailable = (() => {
  try {
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!ffmpegAvailable)("fMP4 audio removal without re-encoding", () => {
  it("drops the audio track from init and media segments; video still decodes", () => {
    const dir = mkdtempSync(join(tmpdir(), "sp-fmp4-"));
    try {
      // The same muxer settings as the recorder (HLS, fMP4 segments).
      execFileSync("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "4", "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", join(dir, "seg_%03d.m4s"), join(dir, "index.m3u8"),
      ]);
      const init = readFileSync(join(dir, "init.mp4"));
      const audio = audioTrackIds(init);
      expect(audio.size).toBe(1);
      const segs = readdirSync(dir).filter((f) => f.endsWith(".m4s")).sort();
      expect(segs.length).toBeGreaterThan(0);

      const parts = [stripAudioInit(init), ...segs.map((f) => stripTracksFromSegment(readFileSync(join(dir, f)), audio))];
      const out = join(dir, "video-only.mp4");
      writeFileSync(out, Buffer.concat(parts));

      const streams = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", out]).toString()).streams;
      expect(streams.map((s: { codec_type: string }) => s.codec_type)).toEqual(["video"]);
      // Decodes cleanly, frame count intact (4 s at 15 fps).
      const frames = execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", out]).toString().trim();
      expect(Number(frames)).toBe(60);
      execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", out, "-f", "null", "-"]);

      // The audio bytes are gone, not just unreferenced.
      const original = Buffer.concat([init, ...segs.map((f) => readFileSync(join(dir, f)))]);
      expect(Buffer.concat(parts).length).toBeLessThan(original.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves video-only recordings untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "sp-fmp4-"));
    try {
      execFileSync("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", join(dir, "seg_%03d.m4s"), join(dir, "index.m3u8"),
      ]);
      const init = readFileSync(join(dir, "init.mp4"));
      expect(audioTrackIds(init).size).toBe(0);
      expect(stripAudioInit(init).equals(init)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
