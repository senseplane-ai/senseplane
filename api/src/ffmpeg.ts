// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// ffmpeg in the API (ADR 0070): stories are rendered and frames for object
// following are read from recordings by a background job. The API image
// carries an LGPL build with OpenH264 (BSD) as its H.264 encoder; a local
// ffmpeg works too, and the encoder is whichever H.264 encoder it has.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const ffmpegPath = () => process.env.FFMPEG_PATH ?? "ffmpeg";

/** Encoders in order of preference: OpenH264 first (what the image ships), then what a local build may have. */
const ENCODERS: Record<string, string[]> = {
  libopenh264: ["-c:v", "libopenh264", "-b:v", "2500k", "-maxrate", "3000k", "-g", "50", "-allow_skip_frames", "0"],
  libx264: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "50", "-profile:v", "main"],
  h264_videotoolbox: ["-c:v", "h264_videotoolbox", "-b:v", "2500k", "-g", "50"],
};

let encoder: Promise<string[]> | undefined;

/** The H.264 encoder arguments to use (STORY_H264_ENCODER picks one by name); throws when ffmpeg has none. */
export function h264Encoder(): Promise<string[]> {
  encoder ??= (async () => {
    const { stdout } = await run(ffmpegPath(), ["-hide_banner", "-encoders"], { encoding: "utf8", maxBuffer: 4 << 20 });
    const have = new Set([...stdout.matchAll(/^\s*V\S*\s+(\S+)/gm)].map((m) => m[1]!));
    const wanted = process.env.STORY_H264_ENCODER;
    const name = wanted ? (have.has(wanted) ? wanted : undefined) : Object.keys(ENCODERS).find((e) => have.has(e));
    if (!name) throw new Error(wanted ? `ffmpeg has no ${wanted} encoder` : "ffmpeg has no H.264 encoder (libopenh264, libx264 or h264_videotoolbox)");
    return ENCODERS[name] ?? ["-c:v", name, "-b:v", "2500k", "-g", "50"];
  })();
  encoder.catch(() => (encoder = undefined));
  return encoder;
}

/** Runs ffmpeg quietly; a failure carries the end of its error output (never any URL or key: inputs are local files). */
export async function ffmpeg(args: string[], timeoutMs = 120_000): Promise<string> {
  try {
    const { stdout } = await run(ffmpegPath(), ["-hide_banner", "-nostdin", "-v", "error", ...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 << 20 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; message?: string };
    const why = e.killed ? "timed out" : (e.stderr ?? e.message ?? "failed").trim().split("\n").slice(-3).join(" ").slice(0, 400);
    throw new Error(`ffmpeg: ${why}`);
  }
}
