// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// ffmpeg in the API (ADR 0070): stories are rendered and frames for object
// following are read from recordings by a background job. The API image
// carries an LGPL build with OpenH264 (BSD) as its H.264 encoder; a local
// ffmpeg works too, and the encoder is whichever H.264 encoder it has.
//
// Decrypted footage reaches ffmpeg on its standard input, never as a file;
// what ffmpeg writes (a story's parts) goes to the work dir (API_WORK_DIR,
// a tmpfs is best), swept of leftovers when the API starts. ffmpeg runs with
// few threads (FFMPEG_THREADS, default 2) and a lower priority (FFMPEG_NICE,
// default 10), so a render doesn't starve the requests it shares a host with.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const ffmpegPath = () => process.env.FFMPEG_PATH ?? "ffmpeg";

/** Where ffmpeg's work files go: API_WORK_DIR, else the system temp dir. */
export const workDir = () => process.env.API_WORK_DIR ?? tmpdir();
/** Prefixes of the work dirs stories and follows make. */
export const WORK_PREFIXES = ["sp-story-", "sp-follow-"];

/**
 * Removes work dirs left by a process that died mid-job (decrypted footage must not linger). Only those
 * older than `olderThanMs`, so a job another process on this host is running keeps its files.
 */
export async function sweepWorkDirs(olderThanMs = 20 * 60_000, dir = workDir()): Promise<number> {
  let n = 0;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!WORK_PREFIXES.some((p) => name.startsWith(p))) continue;
    const path = join(dir, name);
    const st = await stat(path).catch(() => undefined);
    if (!st || Date.now() - st.mtimeMs < olderThanMs) continue;
    await rm(path, { recursive: true, force: true });
    n++;
  }
  return n;
}

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

const NICE = ["/usr/bin/nice", "/bin/nice"].find((p) => existsSync(p));

export interface FfmpegOptions {
  timeoutMs?: number;
  /** Fed to ffmpeg's standard input (use `-i pipe:0`), a buffer at a time. */
  input?: AsyncIterable<Buffer>;
  /** Kills ffmpeg (a job past its deadline, or whose claim was lost). */
  signal?: AbortSignal;
}

/**
 * Runs ffmpeg quietly and returns its standard output. A failure carries the end of its error output (never
 * a URL or a key: inputs are pipes or local files). The last argument is the output.
 */
export async function ffmpeg(args: string[], o: FfmpegOptions | number = {}): Promise<Buffer> {
  const opts: FfmpegOptions = typeof o === "number" ? { timeoutMs: o } : o;
  const threads = process.env.FFMPEG_THREADS ?? "2";
  const full = ["-hide_banner", "-nostdin", "-v", "error", "-filter_threads", "1", ...args.slice(0, -1), "-threads", threads, args.at(-1)!];
  if (opts.input) full.splice(full.indexOf("-nostdin"), 1);
  const nice = process.env.FFMPEG_NICE ?? "10";
  const [cmd, argv] = NICE && nice !== "0" ? [NICE, ["-n", nice, ffmpegPath(), ...full]] : [ffmpegPath(), full];
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let why: string | undefined;
    const kill = (reason: string) => {
      why ??= reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("timed out"), opts.timeoutMs ?? 120_000);
    const onAbort = () => kill("stopped");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) kill("stopped");
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => (err = (err + b.toString()).slice(-4000)));
    child.on("error", (e) => kill(e.message));
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (code === 0 && !why) return resolve(Buffer.concat(out));
      reject(new Error(`ffmpeg: ${why ?? (err.trim().split("\n").slice(-3).join(" ").slice(0, 400) || `exit ${code}`)}`));
    });
    if (opts.input && child.stdin) {
      const stdin = child.stdin;
      stdin.on("error", () => undefined); // ffmpeg may stop reading once it has what it needs (-t)
      void (async () => {
        try {
          for await (const chunk of opts.input!) {
            if (stdin.destroyed) break;
            if (!stdin.write(chunk)) await new Promise<void>((r) => { stdin.once("drain", r); stdin.once("close", r); });
          }
        } catch (e) {
          kill(`input failed: ${(e as Error).message}`);
        } finally {
          stdin.end();
        }
      })();
    }
  });
}

/** Splits ffmpeg's `-f image2pipe -c:v mjpeg` output into JPEGs. */
export function splitJpegs(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length - 1) {
    const start = buf.indexOf(Buffer.from([0xff, 0xd8]), i);
    if (start < 0) break;
    const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) break;
    out.push(buf.subarray(start, end + 2));
    i = end + 2;
  }
  return out;
}
