// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// A camera's continuous feed: one egress session with a `segments` and/or a
// `frames` sink (spec/media/control-api.yaml, callbacks.json).
//
// The egress is a participant, not part of the node: it joins the room with
// the join token it was given (kind egress, transport plain) over the
// ordinary signalling protocol, consumes the camera onto plain RTP
// transports aimed at its own ffmpeg processes, and follows every publisher
// of the room for as long as it runs. A publisher that drops ends the run
// (source.offline); one that comes back starts the next (source.online, then
// recording.gap for the hole). The same code runs in the media server's
// process or on a separate egress host.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { type Log, post } from "../callbacks.js";
import { FeedCallback } from "./callback.js";
import { reservePortPair, type RtpLeg } from "./ffmpeg.js";
import { DEFAULT_BATCH_MS, FramesRun } from "./frames.js";
import { SegmentsRun, fitsResolution } from "./segments.js";
import { type EventFrame, SignalClient } from "./signal-client.js";
import { type Uploader, createUploader } from "./uploader.js";
import type { EgressStart, FramesSink, MaxResolution, SegmentsSink } from "./validate.js";

export type FeedStatus = "starting" | "waiting" | "recording" | "stopping" | "finished" | "failed";

export interface FeedDeps {
  ffmpegPath: string;
  workDir: string;
  /** Where this host's ffmpeg listens for RTP, and the address the node is told to send to. */
  rtpIp: string;
  rtpAnnouncedAddress: string;
  /** The signalling URL used when the job names none. */
  signalUrl: string;
  log: Log;
  fetch?: typeof fetch;
  callbackTimeoutMs?: number;
  /** How long a run waits for audio after its video (a camera publishes audio a moment later). */
  audioSettleMs?: number;
}

type Known = { producerId: string; identity: string; kind: "audio" | "video"; source?: string; seq: number };
type Leg = { role: "segments" | "frames"; kind: "audio" | "video" };
type Transport = { transportId: string; port: number };

interface Run {
  n: number;
  video: Known;
  audio?: Known;
  consumers: { consumerId: string; kind: "audio" | "video"; role: Leg["role"] }[];
  segments?: SegmentsRun;
  frames?: FramesRun;
  timers: NodeJS.Timeout[];
}

export class FeedSession {
  status: FeedStatus = "starting";
  readonly startedAt = new Date().toISOString();
  endedAt?: string;
  error?: string;
  private signal?: SignalClient;
  private routerCaps?: unknown;
  private readonly known = new Map<string, Known>();
  private seq = 0;
  private readonly transports = new Map<string, Transport>();
  private run?: Run;
  private runs = 0;
  private segmentsWritten = 0;
  private lastSegmentAt?: string;
  private lastRunEndedAt?: number;
  private rejected?: { producerId: string; width: number; height: number; maxResolution: MaxResolution };
  private chain: Promise<unknown> = Promise.resolve();
  private ending?: Promise<void>;
  private durationTimer?: NodeJS.Timeout;
  private settleTimer?: NodeJS.Timeout;
  private settleUntil?: number;
  private readonly callback: FeedCallback;
  private readonly uploader?: Uploader;
  private readonly segmentsSink?: SegmentsSink;
  private readonly framesSink?: FramesSink;

  constructor(readonly job: EgressStart, private readonly deps: FeedDeps) {
    this.segmentsSink = job.sinks.find((s): s is SegmentsSink => s.kind === "segments");
    this.framesSink = job.sinks.find((s): s is FramesSink => s.kind === "frames");
    this.callback = new FeedCallback({
      callback: job.callback, sessionId: job.sessionId, room: job.room, log: deps.log,
      ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.callbackTimeoutMs ? { timeoutMs: deps.callbackTimeoutMs } : {}),
    });
    if (this.segmentsSink) this.uploader = createUploader(this.segmentsSink.destination, this.callback, deps.fetch ? { fetch: deps.fetch } : {});
  }

  get id() {
    return this.job.sessionId;
  }

  get terminal() {
    return this.status === "finished" || this.status === "failed";
  }

  snapshot() {
    const streams = this.run ? [this.run.video, ...(this.run.audio ? [this.run.audio] : [])].map((s) => ({ producerId: s.producerId, identity: s.identity, kind: s.kind })) : [];
    return {
      sessionId: this.job.sessionId, room: this.job.room, status: this.status, startedAt: this.startedAt,
      ...(this.endedAt ? { endedAt: this.endedAt } : {}), ...(this.error ? { error: this.error } : {}),
      streams, artifacts: [],
      feed: {
        runs: this.runs, segmentsWritten: this.segmentsWritten + (this.run?.segments?.segments ?? 0),
        ...(this.lastSegmentAt ? { lastSegmentAt: this.lastSegmentAt } : {}),
        ...(this.rejected ? { rejected: { width: this.rejected.width, height: this.rejected.height, maxResolution: this.rejected.maxResolution } } : {}),
      },
    };
  }

  private get metadata(): Record<string, string> {
    return this.segmentsSink?.metadata ?? this.framesSink?.metadata ?? {};
  }

  private emit(event: string, data: Record<string, unknown>, key: string, traceparent?: string) {
    if (event === "segment.written") this.lastSegmentAt = String(data.start);
    this.callback.emit(event, { ...this.metadata, ...data }, key, traceparent);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async start() {
    if (this.job.maxDurationSeconds) {
      this.durationTimer = setTimeout(() => void this.stop("max_duration"), this.job.maxDurationSeconds * 1000);
      this.durationTimer.unref();
    }
    try {
      const signal = new SignalClient(this.job.mediaUrl ?? this.deps.signalUrl);
      this.signal = signal;
      const joined = await signal.join(this.job.joinToken);
      this.routerCaps = joined.routerRtpCapabilities;
      for (const p of (joined.producers as Omit<Known, "seq">[] | undefined) ?? []) this.add(p);
      signal.onEvent((e) => this.onEvent(e));
      void signal.closed.then(({ reason }) => {
        if (!this.terminal && this.status !== "stopping") void this.end("node_lost", `the media node closed the signalling connection (${reason || "closed"})`);
      });
      this.status = "waiting";
      await this.reconcile();
    } catch (err) {
      this.status = "failed";
      this.error = (err as Error).message;
      this.endedAt = new Date().toISOString();
      clearTimeout(this.durationTimer);
      this.signal?.close();
      throw err;
    }
  }

  private add(p: Omit<Known, "seq">) {
    if (p.kind !== "audio" && p.kind !== "video") return;
    const sel = this.job.select;
    if (sel?.identities && !sel.identities.includes(p.identity)) return;
    if (sel?.kinds && !sel.kinds.includes(p.kind)) return;
    this.known.set(p.producerId, { producerId: p.producerId, identity: p.identity, kind: p.kind, ...(p.source ? { source: p.source } : {}), seq: ++this.seq });
  }

  private onEvent(e: EventFrame) {
    if (e.event === "producerAppeared" || e.event === "newProducer") {
      this.add(e as unknown as Known);
      void this.reconcile();
    } else if (e.event === "producerClosed") {
      if (this.known.delete(String(e.producerId))) void this.reconcile();
    } else if (e.event === "roomClosed" || e.event === "draining") {
      void this.end("node_lost", `the media node ended this session (${e.event === "draining" ? "draining" : String(e.reason)})`);
    }
  }

  /** Re-reads what is being published and acts on it, one step at a time. */
  reconcile(): Promise<void> {
    return this.serial(() => this.reconcileNow());
  }

  private async reconcileNow() {
    if (this.terminal || this.status === "stopping") return;
    const all = [...this.known.values()].sort((a, b) => b.seq - a.seq);
    const video = all.find((p) => p.kind === "video");
    const wantsAudio = (this.segmentsSink?.audio ?? true) || (this.framesSink?.audio ?? true);
    const audio = video && wantsAudio ? all.find((p) => p.kind === "audio" && p.identity === video.identity) : undefined;
    if (this.run) {
      // The same video keeps its run: a running ffmpeg can't gain an input, so late audio waits for the next run.
      if (video && this.run.video.producerId === video.producerId) return;
      await this.endRun(video ? "publisher_replaced" : "publisher_left");
    }
    if (!video) {
      this.settleUntil = undefined;
      this.status = "waiting";
      return;
    }
    if (this.rejected?.producerId === video.producerId) return;
    if (wantsAudio && !audio) {
      const now = Date.now();
      this.settleUntil ??= now + (this.deps.audioSettleMs ?? 2000);
      if (now < this.settleUntil) {
        if (!this.settleTimer) {
          this.settleTimer = setTimeout(() => {
            this.settleTimer = undefined;
            void this.reconcile();
          }, this.settleUntil - now);
          this.settleTimer.unref();
        }
        return;
      }
    }
    this.settleUntil = undefined;
    await this.startRun(video, audio);
  }

  private async transport(role: Leg["role"], kind: Leg["kind"]): Promise<Transport> {
    const name = `${role}:${kind}`;
    const have = this.transports.get(name);
    if (have) return have;
    const signal = this.signal!;
    const t = await signal.request<{ transportId: string }>("createTransport", { direction: "recv" });
    const port = await reservePortPair(this.deps.rtpIp);
    await signal.request("connectTransport", { transportId: t.transportId, ip: this.deps.rtpAnnouncedAddress, port, rtcpPort: port + 1 });
    const out = { transportId: t.transportId, port };
    this.transports.set(name, out);
    return out;
  }

  private async startRun(video: Known, audio: Known | undefined) {
    const n = ++this.runs;
    const signal = this.signal!;
    const run: Run = { n, video, ...(audio ? { audio } : {}), consumers: [], timers: [] };
    const legsFor = async (role: Leg["role"], withAudio: boolean): Promise<RtpLeg[]> => {
      const out: RtpLeg[] = [];
      for (const p of [video, ...(withAudio && audio ? [audio] : [])]) {
        const t = await this.transport(role, p.kind);
        const c = await signal.request<{ consumerId: string; rtpParameters: RtpLeg["rtpParameters"] }>("consume", {
          transportId: t.transportId, producerId: p.producerId, rtpCapabilities: this.routerCaps,
        });
        run.consumers.push({ consumerId: c.consumerId, kind: p.kind, role });
        out.push({ kind: p.kind, port: t.port, rtpParameters: c.rtpParameters });
      }
      return out;
    };
    try {
      const dir = join(this.deps.workDir, this.job.sessionId, `run-${n}`);
      if (this.segmentsSink && this.uploader) {
        const sink = this.segmentsSink;
        run.segments = new SegmentsRun({
          run: n, dir: join(dir, "segments"), sessionId: this.job.sessionId, keyPrefix: sink.keyPrefix, segmentSeconds: sink.segmentSeconds ?? 6,
          ...(sink.maxResolution ? { maxResolution: sink.maxResolution } : {}),
          legs: await legsFor("segments", sink.audio ?? true), ip: this.deps.rtpIp, ffmpegPath: this.deps.ffmpegPath, uploader: this.uploader,
          emit: (event, data, key, traceparent) => this.emit(event, data, key, traceparent),
          onAccepted: () => {
            if (run.frames) run.frames.enabled = true;
          },
          onRejected: (size) => void this.serial(() => this.rejectRun(run, size)),
          log: this.deps.log,
        });
      }
      if (this.framesSink) {
        const sink = this.framesSink;
        run.frames = new FramesRun({
          dir: join(dir, "frames"), sessionId: this.job.sessionId, room: this.job.room, fps: sink.fps ?? 5, batchMs: sink.batchMs ?? DEFAULT_BATCH_MS,
          legs: await legsFor("frames", sink.audio ?? true), ip: this.deps.rtpIp, ffmpegPath: this.deps.ffmpegPath,
          callback: this.job.callback, metadata: this.metadata, log: this.deps.log,
          ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), ...(this.deps.callbackTimeoutMs ? { timeoutMs: this.deps.callbackTimeoutMs } : {}),
          // Frames start as soon as the decoder knows the size and it is within maxResolution; above it, the segments
          // sink refuses the run and nothing is sent.
          onSize: (size) => {
            const max = this.segmentsSink?.maxResolution;
            if (run.frames && (!max || fitsResolution(size.width, size.height, max))) run.frames.enabled = true;
          },
        });
        // Nothing reaches the callback above maxResolution either.
        run.frames.enabled = !this.segmentsSink?.maxResolution;
      }
      await run.segments?.start();
      await run.frames?.start();
      this.run = run;
      // Give ffmpeg a moment to bind its ports, then let media flow from a keyframe.
      await new Promise((r) => setTimeout(r, 400));
      for (const c of run.consumers) await signal.request("resumeConsumer", { consumerId: c.consumerId });
      for (const c of run.consumers.filter((x) => x.kind === "video")) {
        const every = c.role === "segments" ? 2000 : 4000;
        const t = setInterval(() => void signal.request("requestKeyFrame", { consumerId: c.consumerId }).catch(() => undefined), every);
        t.unref();
        run.timers.push(t);
      }
    } catch (err) {
      this.deps.log.warn({ err, sessionId: this.job.sessionId }, "could not start a feed run");
      this.run = run;
      await this.endRun("start_failed", false);
      return;
    }
    this.status = "recording";
    const at = new Date().toISOString();
    const codecs = [...new Set([video, ...(audio ? [audio] : [])].map((p) => (p.kind === "video" ? "h264" : "opus")))];
    this.emit("source.online", { at, codecs, producer_id: video.producerId, identity: video.identity }, `source.online:${this.job.sessionId}:${n}`);
    if (this.lastRunEndedAt !== undefined) {
      this.emit("recording.gap", { from: new Date(this.lastRunEndedAt).toISOString(), to: at, reason: "publisher_reconnected" }, `recording.gap:${this.job.sessionId}:${n}`);
    }
  }

  private async closeRun(run: Run) {
    for (const t of run.timers) clearInterval(t);
    for (const c of run.consumers) await this.signal?.request("closeConsumer", { consumerId: c.consumerId }).catch(() => undefined);
    await Promise.allSettled([run.segments?.stop(), run.frames?.stop()]);
    this.segmentsWritten += run.segments?.segments ?? 0;
  }

  private async endRun(reason: string, announce = true) {
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    // Announced first: the camera is offline now, not once its last segment is flushed and uploaded.
    if (announce) {
      this.lastRunEndedAt = Date.now();
      this.emit("source.offline", { at: new Date(this.lastRunEndedAt).toISOString(), reason, producer_id: run.video.producerId }, `source.offline:${this.job.sessionId}:${run.n}`);
    }
    await this.closeRun(run);
  }

  /** Above maxResolution: nothing of this run was stored, and nothing will be. The caller decides whether to remove the publisher. */
  private async rejectRun(run: Run, size: { width: number; height: number }) {
    if (this.run !== run) return;
    const max = this.segmentsSink!.maxResolution!;
    this.rejected = { producerId: run.video.producerId, ...size, maxResolution: max };
    this.run = undefined;
    await this.closeRun(run);
    this.emit("resolution_rejected", {
      at: new Date().toISOString(), width: size.width, height: size.height, max_resolution: max, producer_id: run.video.producerId, identity: run.video.identity,
    }, `resolution_rejected:${this.job.sessionId}:${run.n}`);
    if (!this.terminal) this.status = "waiting";
  }

  stop(reason = "requested"): Promise<void> {
    return this.end(reason);
  }

  private end(reason: string, detail?: string): Promise<void> {
    this.ending ??= this.serial(async () => {
      if (this.terminal) return;
      this.status = "stopping";
      clearTimeout(this.durationTimer);
      clearTimeout(this.settleTimer);
      if (detail) this.error = detail;
      try {
        await this.endRun(reason === "requested" ? "stopped" : reason);
        await this.signal?.request("leave").catch(() => undefined);
        this.signal?.close();
        this.status = "finished";
      } catch (err) {
        this.status = "failed";
        this.error = detail ?? (err as Error).message;
      }
      await this.callback.drain().catch(() => undefined);
      await rm(join(this.deps.workDir, this.job.sessionId), { recursive: true, force: true }).catch(() => undefined);
      this.endedAt = new Date().toISOString();
      this.deps.log.info({ sessionId: this.job.sessionId, reason, status: this.status }, "feed session ended");
      await this.notifyEnded();
    });
    return this.ending;
  }

  /** egress.session.ended, a few tries: the caller's reconcile is the backstop. */
  private async notifyEnded() {
    const body = JSON.stringify({ event: "egress.session.ended", sentAt: new Date().toISOString(), session: this.snapshot() });
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await post(this.job.callback, body, this.deps.callbackTimeoutMs ?? 10_000, this.deps.fetch);
        await res.arrayBuffer().catch(() => undefined);
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)) return;
      } catch {
        // retried
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    this.deps.log.warn({ sessionId: this.job.sessionId }, "egress.session.ended callback failed");
  }
}
