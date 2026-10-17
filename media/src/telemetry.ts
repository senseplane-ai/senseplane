// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Media-plane metrics (Prometheus /metrics, scraped by the OpenTelemetry
// Collector when the observability profile runs) and FFmpeg process tracking.
// Traces come from @senseplane/telemetry (ADR 0033).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { types } from "mediasoup";
import { Counter, Gauge, Histogram, type Registry } from "prom-client";

const exec = promisify(execFile);

export const metrics = {
  segmentUpload: new Histogram({
    name: "senseplane_media_segment_upload_seconds", help: "Time to upload one recorded segment to object storage",
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10], registers: [],
  }),
  segmentUploadErrors: new Counter({ name: "senseplane_media_segment_upload_errors_total", help: "Segment uploads that failed (retried later)", registers: [] }),
  segmentsWritten: new Counter({ name: "senseplane_media_segments_written_total", help: "Segments uploaded and announced", registers: [] }),
  analysisFrames: new Counter({ name: "senseplane_media_analysis_frames_total", help: "Analysis frames published to the brain", registers: [] }),
  analysisFramesDropped: new Counter({
    name: "senseplane_media_analysis_frames_dropped_total", help: "Analysis frames expected at the configured fps but not produced by the decoder", registers: [],
  }),
  analysisFps: new Gauge({ name: "senseplane_media_analysis_fps", help: "Average analysis frames per second per feed over the last interval", registers: [] }),
  ffmpegRestarts: new Counter({ name: "senseplane_media_ffmpeg_unexpected_exits_total", help: "FFmpeg processes that exited without being stopped", labelNames: ["role"], registers: [] }),
};

/** FFmpeg child processes by pid, for the recorder-memory gauge. */
export const ffmpegProcesses = new Map<number, "recorder" | "analysis">();

export interface MediaGaugeSources {
  workers: types.Worker[];
  liveProducers(): number;
  recorders(): number;
  feeds(): number;
}

/** Registers media metrics on the service registry; gauges read live state on each scrape. */
export function registerMediaMetrics(registry: Registry, src: MediaGaugeSources) {
  for (const m of Object.values(metrics)) registry.registerMetric(m);
  new Gauge({
    name: "senseplane_media_active_producers", help: "mediasoup producers publishing on this node", registers: [registry],
    collect() { this.set(src.liveProducers()); },
  });
  new Gauge({
    name: "senseplane_media_streams_per_worker", help: "Recording sessions per live mediasoup worker", registers: [registry],
    collect() { this.set(src.recorders() / Math.max(1, src.workers.filter((w) => !w.closed && !w.died).length)); },
  });
  new Gauge({ name: "senseplane_media_recorders", help: "Recorders running on this node", registers: [registry], collect() { this.set(src.recorders()); } });
  new Gauge({ name: "senseplane_media_analysis_feeds", help: "Analysis decoders running on this node", registers: [registry], collect() { this.set(src.feeds()); } });
  new Gauge({
    name: "senseplane_media_ffmpeg_rss_bytes", help: "Resident memory of FFmpeg processes (recorders and analysis decoders)", labelNames: ["role"], registers: [registry],
    async collect() {
      this.reset();
      const pids = [...ffmpegProcesses.keys()];
      if (!pids.length) return;
      try {
        const { stdout } = await exec("ps", ["-o", "pid=,rss=", "-p", pids.join(",")]);
        const byRole: Record<string, number> = {};
        for (const line of stdout.trim().split("\n")) {
          const [pid, rss] = line.trim().split(/\s+/).map(Number);
          const role = ffmpegProcesses.get(pid!);
          if (role && Number.isFinite(rss)) byRole[role] = (byRole[role] ?? 0) + rss! * 1024;
        }
        for (const [role, bytes] of Object.entries(byRole)) this.set({ role }, bytes);
      } catch {
        // ps unavailable or processes gone between listing and reading: report nothing this scrape
      }
    },
  });
  // The CPU gauge reads each worker's usage once per scrape and fills the memory
  // gauge too, which is registered after it so it serialises the fresh values.
  const rss = new Gauge({ name: "senseplane_media_worker_maxrss_bytes", help: "Peak resident memory of each mediasoup worker", labelNames: ["worker"], registers: [] });
  new Gauge({
    name: "senseplane_media_worker_cpu_seconds", help: "CPU time used by each mediasoup worker (user + system)", labelNames: ["worker"], registers: [registry],
    async collect() {
      await Promise.all(src.workers.map(async (w, i) => {
        if (w.closed || w.died) return;
        try {
          const u = await w.getResourceUsage();
          this.set({ worker: String(i) }, (u.ru_utime + u.ru_stime) / 1000);
          rss.set({ worker: String(i) }, u.ru_maxrss * 1024);
        } catch {
          // worker busy closing: skip this scrape
        }
      }));
    },
  });
  registry.registerMetric(rss);
}
