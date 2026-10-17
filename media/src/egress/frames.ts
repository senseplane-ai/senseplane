// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The `frames` sink for one run of a feed (spec/media/callbacks.json
// framesBatch): ffmpeg decodes the camera at ≤ 5 fps into a fixed 640x360
// letterboxed box as JPEG, and downmixes audio to 16 kHz mono f32. Once a
// second the frames and the second of audio since the last batch are POSTed
// to the callback as one multipart body. Stale frames are worth nothing, so
// batches wait in a short queue and the oldest is dropped first.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Callback, type Log, permanent, post } from "../callbacks.js";
import { SpanKind, sampleRatio, untraced, withSpan } from "@senseplane/telemetry";
import { ffmpegProcesses, metrics } from "../telemetry.js";

/** Head sampling of analysis frames into traces (ADR 0033): the share of batches that start a trace. */
const FRAME_TRACE_RATIO = sampleRatio("SENSEPLANE_TRACE_FRAMES_RATIO", 0.01);
import { type RtpLeg, sdpFor } from "./ffmpeg.js";

export const FRAME_W = 640;
export const FRAME_H = 360;
export const SAMPLE_RATE = 16_000;
const AUDIO_CHUNK_BYTES = SAMPLE_RATE * 4;
const MAX_FRAMES = 5;
/** How often frames are sent when the sink sets no batchMs (spec/media/control-api.yaml FramesSink). */
export const DEFAULT_BATCH_MS = 1000;
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

type Batch = { form: () => FormData; key: string; tries: number; traced?: boolean; frames?: number };

/** Splits a concatenated MJPEG byte stream into whole JPEGs (SOI … EOI; byte stuffing keeps FFD9 out of entropy data). */
export class JpegSplitter {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer, onJpeg: (jpeg: Buffer) => void) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const start = this.buf.indexOf(SOI);
      if (start < 0) {
        this.buf = Buffer.alloc(0);
        return;
      }
      const end = this.buf.indexOf(EOI, start + 2);
      if (end < 0) {
        if (start > 0) this.buf = this.buf.subarray(start);
        return;
      }
      onJpeg(Buffer.from(this.buf.subarray(start, end + 2)));
      this.buf = this.buf.subarray(end + 2);
    }
  }
}

export interface FramesRunOptions {
  dir: string;
  sessionId: string;
  room: string;
  fps: number;
  /** Send the frames gathered so far this often. */
  batchMs: number;
  legs: RtpLeg[];
  ip: string;
  ffmpegPath: string;
  callback: Callback;
  metadata: Record<string, string>;
  log: Log;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The stream's size, from the decoder's first frame (well before the first segment closes). */
  onSize?: (size: { width: number; height: number }) => void;
}

export class FramesRun {
  private ff?: ChildProcess;
  private flush?: NodeJS.Timeout;
  private frames: { body: Buffer; at: Date }[] = [];
  private audio: { body: Buffer; at: Date }[] = [];
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private readonly queue: Batch[] = [];
  private running?: Promise<void>;
  private seq = 0;
  /** Frames flow only once the segments sink accepted the stream's resolution. */
  enabled = false;
  sent = 0;
  stopped = false;

  constructor(private readonly o: FramesRunOptions) {}

  async start() {
    await mkdir(this.o.dir, { recursive: true });
    await writeFile(join(this.o.dir, "in.sdp"), sdpFor(this.o.legs, this.o.ip));
    const hasAudio = this.o.legs.some((l) => l.kind === "audio");
    const args = [
      // Low-latency input: no probing window, no reorder queue, decode from the first keyframe
      // (not +nobuffer: that drops the packets the probe read, the first keyframe among them).
      // verbose: the scaler logs the input size when the first frame is decoded.
      "-hide_banner", "-nostats", "-loglevel", "verbose", "-protocol_whitelist", "file,udp,rtp", "-fflags", "+genpts",
      "-flags", "low_delay", "-analyzeduration", "0", "-probesize", "32", "-max_delay", "0", "-reorder_queue_size", "0",
      "-i", join(this.o.dir, "in.sdp"),
      "-map", "0:v:0", "-an", "-vf",
      `fps=${this.o.fps},scale=${FRAME_W}:${FRAME_H}:force_original_aspect_ratio=decrease,pad=${FRAME_W}:${FRAME_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuvj420p`,
      "-c:v", "mjpeg", "-q:v", "5", "-f", "image2pipe", "pipe:1",
      ...(hasAudio ? ["-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "pipe:3"] : []),
    ];
    const ff = spawn(this.o.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    this.ff = ff;
    const pid = ff.pid;
    if (pid) ffmpegProcesses.set(pid, "analysis");
    let stderr = "";
    let sized = false;
    ff.stderr!.on("data", (d) => {
      stderr = (stderr + d).slice(-2000);
      if (sized || !this.o.onSize) return;
      const m = /Parsed_scale_\d+ @ [^\]]+\] w:(\d+) h:(\d+) fmt:[^\n]*->/.exec(stderr);
      if (!m) return;
      sized = true;
      this.o.onSize({ width: Number(m[1]), height: Number(m[2]) });
    });
    ff.on("exit", (code) => {
      if (pid) ffmpegProcesses.delete(pid);
      if (!this.stopped && code && code !== 255) {
        metrics.ffmpegRestarts.inc({ role: "analysis" });
        this.o.log.warn({ code, stderr, sessionId: this.o.sessionId }, "frames decoder exited");
      }
    });
    const jpegs = new JpegSplitter();
    ff.stdout!.on("data", (chunk: Buffer) => jpegs.push(chunk, (jpeg) => {
      if (!this.enabled) return;
      this.frames.push({ body: jpeg, at: new Date() });
      if (this.frames.length > MAX_FRAMES * 3) this.frames.shift();
      metrics.analysisFrames.inc();
    }));
    if (hasAudio) {
      (ff.stdio[3] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
        this.pendingAudio.push(chunk);
        this.pendingAudioBytes += chunk.length;
        while (this.pendingAudioBytes >= AUDIO_CHUNK_BYTES) {
          const all = Buffer.concat(this.pendingAudio, this.pendingAudioBytes);
          if (this.enabled) this.audio.push({ body: Buffer.from(all.subarray(0, AUDIO_CHUNK_BYTES)), at: new Date(Date.now() - 1000) });
          const rest = all.subarray(AUDIO_CHUNK_BYTES);
          this.pendingAudio = rest.length ? [Buffer.from(rest)] : [];
          this.pendingAudioBytes = rest.length;
        }
      });
    }
    // Frames go as they come (a batch every batchMs holds the frames since the last one), so an alert
    // waits for the detector, not for a second's batch; audio goes once a second, as it fills.
    this.flush = setInterval(() => this.batch(), this.o.batchMs);
    this.flush.unref();
  }

  /** Every batchMs: the newest frames (≤ 5) and each second of audio since the last batch, one POST per second of audio. */
  private batch() {
    const frames = this.frames.splice(0).slice(-MAX_FRAMES);
    const chunks = this.audio.splice(0);
    if (!frames.length && !chunks.length) return;
    for (let i = 0; i < Math.max(1, chunks.length); i++) this.enqueue(i === Math.max(1, chunks.length) - 1 ? frames : [], chunks[i]);
  }

  private enqueue(frames: { body: Buffer; at: Date }[], audio: { body: Buffer; at: Date } | undefined) {
    if (!frames.length && !audio) return;
    const key = `frames:${this.o.sessionId}:${++this.seq}`;
    const meta = {
      event: "frames", sentAt: new Date().toISOString(), sessionId: this.o.sessionId, room: this.o.room, idempotencyKey: key,
      data: {
        ...this.o.metadata,
        frames: frames.map((f, i) => ({ part: `frame${i}`, captured_at: f.at.toISOString(), width: FRAME_W, height: FRAME_H, format: "jpeg" })),
        ...(audio ? { audio: { part: "audio", captured_at: audio.at.toISOString(), sample_rate: SAMPLE_RATE, samples: audio.body.length / 4, format: "f32le_mono" } } : {}),
      },
    };
    const form = () => {
      const fd = new FormData();
      fd.append("meta", new Blob([JSON.stringify(meta)], { type: "application/json" }), "meta.json");
      frames.forEach((f, i) => fd.append(`frame${i}`, new Blob([new Uint8Array(f.body)], { type: "image/jpeg" }), `frame${i}.jpg`));
      if (audio) fd.append("audio", new Blob([new Uint8Array(audio.body)], { type: "application/octet-stream" }), "audio.raw");
      return fd;
    };
    if (this.queue.length >= 10) {
      this.queue.splice(1, 1); // the oldest not in flight: a late frame is a useless frame
      metrics.analysisFramesDropped.inc(MAX_FRAMES);
    }
    this.queue.push({ form, key, tries: 0, traced: FRAME_TRACE_RATIO > 0 && Math.random() < FRAME_TRACE_RATIO, frames: frames.length });
    this.kick();
  }

  private kick() {
    if (this.running) return;
    this.running = this.pump().finally(() => (this.running = undefined));
  }

  private async pump() {
    while (this.queue.length) {
      const b = this.queue[0]!;
      let done = false;
      try {
        // A sampled batch is the root of a trace; the HTTP instrumentation carries it on as traceparent.
        const send = () => post(this.o.callback, b.form(), this.o.timeoutMs ?? 5000, this.o.fetch);
        const res = b.traced
          ? await withSpan("media.frame", {
            kind: SpanKind.PRODUCER, root: true, attributes: { "senseplane.session_id": this.o.sessionId, "senseplane.frames": b.frames ?? 0 },
          }, () => send())
          : await untraced(send);
        await res.arrayBuffer().catch(() => undefined);
        done = res.ok || permanent(res.status);
        if (res.ok) this.sent++;
      } catch {
        // retried below
      }
      if (!done && ++b.tries < 3) {
        await new Promise((r) => setTimeout(r, 200 * b.tries));
        continue;
      }
      if (this.queue[0] === b) this.queue.shift();
    }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.flush);
    this.batch();
    this.ff?.kill("SIGKILL");
    const deadline = Date.now() + 3000;
    while (this.queue.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await rm(this.o.dir, { recursive: true, force: true });
  }
}
