// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The `segments` sink for one run of a feed (ADR 0010, 0015): ~6 s fMP4
// segments, stream copy only, uploaded to the caller's bucket the moment each
// closes, each announced with segment.written. The init segment is read from
// local disk before anything is uploaded: above maxResolution nothing is
// stored and resolution_rejected is sent (ADR 0022).
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { SpanKind, currentTraceparent, withSpan } from "@senseplane/telemetry";
import type { Log } from "../callbacks.js";
import { parsePlaylist } from "../playlist.js";
import { ffmpegProcesses, metrics } from "../telemetry.js";
import { type RtpLeg, ffprobePath, sdpFor, wakeDemuxer } from "./ffmpeg.js";
import type { Uploader } from "./uploader.js";
import type { MaxResolution } from "./validate.js";

const exec = promisify(execFile);
const LIMITS = { "720p": [1280, 720], "1080p": [1920, 1080] } as const;
const UPLOAD_ATTEMPTS = 5;

/** True if a frame size fits a maximum resolution; portrait counts the same as landscape. */
export function fitsResolution(width: number, height: number, max: MaxResolution): boolean {
  const [long, short] = LIMITS[max];
  return Math.max(width, height) <= long && Math.min(width, height) <= short;
}

/** `<prefix>{yyyy}/{mm}/{dd}/{start_ms}.m4s`, the day in UTC. */
export function segmentKey(prefix: string, startMs: number): string {
  const d = new Date(startMs).toISOString();
  return `${withSlash(prefix)}${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}/${startMs}.m4s`;
}

/** `<prefix>init/{sessionId}.mp4`, `{sessionId}-{run}.mp4` after the first run. */
export function initKey(prefix: string, sessionId: string, run: number): string {
  return `${withSlash(prefix)}init/${run <= 1 ? sessionId : `${sessionId}-${run}`}.mp4`;
}
const withSlash = (p: string) => (p.endsWith("/") ? p : `${p}/`);

async function probeSize(ffmpegPath: string, file: string): Promise<{ width: number; height: number } | undefined> {
  try {
    const { stdout } = await exec(ffprobePath(ffmpegPath), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
    const [width, height] = stdout.trim().split(",").map(Number);
    return width && height ? { width, height } : undefined;
  } catch {
    return undefined;
  }
}

/** Duration of one fMP4 segment from its packet timestamps. */
async function probeDurationMs(ffmpegPath: string, init: string, segment: string): Promise<number> {
  const tmp = `${segment}.probe.mp4`;
  try {
    await writeFile(tmp, Buffer.concat([await readFile(init), await readFile(segment)]));
    const { stdout } = await exec(ffprobePath(ffmpegPath), ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", tmp]);
    const rows = stdout.trim().split("\n").map((l) => l.split(",").map(Number)).filter((r) => Number.isFinite(r[0]));
    if (rows.length < 2) return 0;
    const pts = rows.map((r) => r[0]!);
    const frame = rows[0]![1] && Number.isFinite(rows[0]![1]) ? rows[0]![1]! : (Math.max(...pts) - Math.min(...pts)) / (rows.length - 1);
    return Math.round((Math.max(...pts) - Math.min(...pts) + frame) * 1000);
  } catch {
    return 0;
  } finally {
    await rm(tmp, { force: true });
  }
}

export interface SegmentsRunOptions {
  run: number;
  dir: string;
  sessionId: string;
  keyPrefix: string;
  segmentSeconds: number;
  maxResolution?: MaxResolution;
  legs: RtpLeg[];
  ip: string;
  ffmpegPath: string;
  uploader: Uploader;
  emit(event: string, data: Record<string, unknown>, key: string, traceparent?: string): void;
  /** The init segment is within maxResolution (or there is no limit): frames may flow. */
  onAccepted(): void;
  onRejected(size: { width: number; height: number }): void;
  log: Log;
}

export class SegmentsRun {
  private ff?: ChildProcess;
  private exited?: Promise<void>;
  private poll?: NodeJS.Timeout;
  private collecting?: Promise<void>;
  private initKey?: string;
  private size?: { width: number; height: number };
  private readonly uploaded = new Set<string>();
  private readonly failures = new Map<string, number>();
  private startedAt = Date.now();
  private stopped = false;
  private lastEnd?: number;
  private stderr = "";
  rejected?: { width: number; height: number };
  segments = 0;

  constructor(private readonly o: SegmentsRunOptions) {}

  private get hasAudio() {
    return this.o.legs.some((l) => l.kind === "audio");
  }

  async start() {
    await mkdir(this.o.dir, { recursive: true });
    await writeFile(join(this.o.dir, "in.sdp"), sdpFor(this.o.legs, this.o.ip));
    const args = [
      "-hide_banner", "-nostats", "-loglevel", "info", // info: the input dump carries the size
      "-protocol_whitelist", "file,udp,rtp", "-fflags", "+genpts",
      "-analyzeduration", "3000000", "-probesize", "5000000",
      "-i", join(this.o.dir, "in.sdp"),
      "-map", "0:v:0", ...(this.hasAudio ? ["-map", "0:a:0"] : []),
      "-c", "copy",
      "-f", "hls", "-hls_time", String(this.o.segmentSeconds), "-hls_segment_type", "fmp4",
      "-hls_flags", "program_date_time+independent_segments", "-hls_list_size", "20",
      "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", join(this.o.dir, "seg_%06d.m4s"),
      join(this.o.dir, "index.m3u8"),
    ];
    const ff = spawn(this.o.ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
    this.ff = ff;
    const pid = ff.pid;
    if (pid) ffmpegProcesses.set(pid, "recorder");
    ff.stderr!.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-4000);
      if (this.size) return;
      const m = /Stream #0:\d+[^\n]*Video: h264[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(this.stderr);
      if (m) this.decide({ width: Number(m[1]), height: Number(m[2]) });
    });
    this.exited = new Promise((resolve) => ff.once("exit", (code, signal) => {
      if (pid) ffmpegProcesses.delete(pid);
      if (!this.stopped) {
        metrics.ffmpegRestarts.inc({ role: "recorder" });
        this.o.log.error({ code, signal, stderr: this.stderr, sessionId: this.o.sessionId }, "segments ffmpeg exited unexpectedly");
      }
      resolve();
    }));
    this.startedAt = Date.now();
    // One collect at a time: a slow pass skips ticks instead of queueing them.
    this.poll = setInterval(() => {
      if (this.collecting) return;
      this.collecting = this.collect(false).catch((err) => this.o.log.warn({ err }, "segment collect failed")).finally(() => (this.collecting = undefined));
    }, 500);
  }

  get exitedOnItsOwn() {
    return this.ff ? this.ff.exitCode !== null && !this.stopped : false;
  }

  /**
   * The resolution check, once per run, as soon as the size is known: from ffmpeg's input
   * dump (about a second in) or else the init segment (which hlsenc writes only with the
   * first segment). Accepting early lets frames start before the first segment closes.
   */
  private decide(size: { width: number; height: number }) {
    if (this.size) return;
    this.size = size;
    if (this.o.maxResolution && !fitsResolution(size.width, size.height, this.o.maxResolution)) {
      this.rejected = size;
      this.o.log.warn({ sessionId: this.o.sessionId, ...size, max: this.o.maxResolution }, "stream above maxResolution; refused before anything was stored");
      this.o.onRejected(size);
      return;
    }
    this.o.onAccepted();
  }

  /** Uploads the init (after the resolution check), then every newly closed segment. */
  private async collect(final: boolean): Promise<void> {
    if (this.rejected) return;
    if (!this.initKey) {
      try {
        await stat(join(this.o.dir, "init.mp4"));
      } catch {
        return;
      }
      // Probed even when the size is known: a readable init is a complete one.
      const size = await probeSize(this.o.ffmpegPath, join(this.o.dir, "init.mp4"));
      if (!size) return;
      this.decide(size);
      if (this.rejected) return;
      const key = initKey(this.o.keyPrefix, this.o.sessionId, this.o.run);
      await this.o.uploader.put(key, await readFile(join(this.o.dir, "init.mp4")), "video/mp4");
      this.initKey = key;
    }
    let text: string;
    try {
      text = await readFile(join(this.o.dir, "index.m3u8"), "utf8");
    } catch {
      return;
    }
    let cursor = this.startedAt;
    const entries = parsePlaylist(text);
    // A rolling playlist (last 20) keeps ffmpeg's memory flat over days; forget names that rolled out.
    const listed = new Set(entries.map((e) => e.uri));
    for (const name of this.uploaded) if (!listed.has(name)) this.uploaded.delete(name);
    for (const entry of entries) {
      const start = entry.start ?? new Date(cursor);
      cursor = start.getTime() + entry.durationMs;
      if (this.uploaded.has(entry.uri)) continue;
      const ok = await this.upload(entry.uri, start.getTime(), entry.durationMs, final);
      if (!ok) return;
    }
  }

  /** false: stop this pass and retry on the next one. */
  private async upload(name: string, startMs: number, durationMs: number, final: boolean): Promise<boolean> {
    const path = join(this.o.dir, name);
    const body = await readFile(path).catch(() => undefined);
    if (!body) {
      this.uploaded.add(name);
      return true;
    }
    const key = segmentKey(this.o.keyPrefix, startMs);
    const t0 = performance.now();
    let traceparent: string | undefined;
    try {
      traceparent = await withSpan("media.segment.upload", {
        kind: SpanKind.PRODUCER, root: true, attributes: { "senseplane.session_id": this.o.sessionId, "senseplane.segment_ms": durationMs },
      }, async () => {
        await this.o.uploader.put(key, body, "video/iso.segment");
        return currentTraceparent();
      });
      metrics.segmentUpload.observe((performance.now() - t0) / 1000);
      metrics.segmentsWritten.inc();
    } catch (err) {
      metrics.segmentUploadErrors.inc();
      const tries = (this.failures.get(name) ?? 0) + 1;
      this.failures.set(name, tries);
      if (tries < UPLOAD_ATTEMPTS && !final) {
        this.o.log.warn({ key, tries, err: (err as Error).message }, "segment upload failed; will retry");
        return false;
      }
      // Given up: said out loud as a gap, and off the disk.
      this.o.log.error({ key, tries, err: (err as Error).message }, "giving up on a segment");
      this.uploaded.add(name);
      await rm(path, { force: true });
      this.o.emit("recording.gap", { from: new Date(startMs).toISOString(), to: new Date(startMs + durationMs).toISOString(), reason: "upload_failed" }, `recording.gap:${key}`);
      return true;
    }
    this.uploaded.add(name);
    this.segments++;
    this.lastEnd = startMs + durationMs;
    await rm(path, { force: true });
    this.o.emit("segment.written", {
      key, init_key: this.initKey, start: new Date(startMs).toISOString(), duration_ms: durationMs, bytes: body.length,
      codec: "h264", has_audio: this.hasAudio, ...(this.size ?? {}),
    }, `segment.written:${key}`, traceparent);
    return true;
  }

  /** Segment files ffmpeg wrote but never listed (interrupted at exit): probe and upload them too. */
  private async collectOrphans(): Promise<void> {
    if (!this.initKey) return;
    const files = (await readdir(this.o.dir).catch(() => [] as string[])).filter((f) => /^seg_\d+\.m4s$/.test(f) && !this.uploaded.has(f)).sort();
    for (const f of files) {
      const durationMs = await probeDurationMs(this.o.ffmpegPath, join(this.o.dir, "init.mp4"), join(this.o.dir, f));
      if (!durationMs) continue;
      await this.upload(f, this.lastEnd ?? Date.now() - durationMs, durationMs, true);
    }
  }

  /**
   * Finalises the open segment and stops. "q" works while media still flows;
   * if the publisher vanished, a few harmless packets wake the blocked demuxer
   * so ffmpeg ends as after a normal "q" and the open segment is written.
   * SIGINT is the fallback (it can lose the open segment), SIGKILL the last resort.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const ff = this.ff;
    const within = (ms: number) => Promise.race([this.exited!.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
    if (ff && ff.exitCode === null && ff.signalCode === null) {
      if (this.rejected) ff.kill("SIGKILL");
      else {
        ff.stdin?.write("q");
        await new Promise((r) => setTimeout(r, 200)); // the "q" is read first, so the wake-up isn't recorded
        await wakeDemuxer(this.o.legs, this.o.ip);
        if (!(await within(3000))) {
          ff.kill("SIGINT");
          await new Promise((r) => setTimeout(r, 200));
          ff.kill("SIGINT");
          if (!(await within(3000))) ff.kill("SIGKILL");
        }
      }
      await this.exited;
    }
    clearInterval(this.poll);
    await this.collecting;
    if (!this.rejected) {
      await this.collect(true).catch((err) => this.o.log.warn({ err }, "final segment collect failed"));
      await this.collectOrphans().catch((err) => this.o.log.warn({ err }, "orphan segment collect failed"));
    }
    if (this.segments === 0 && !this.rejected) this.o.log.warn({ sessionId: this.o.sessionId, stderr: this.stderr }, "run stopped without segments");
    await rm(this.o.dir, { recursive: true, force: true });
  }
}
