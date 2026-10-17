// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Single-node load test: N concurrent 1080p H.264 cameras (dev replay
// publisher) recorded through the feed egress into presigned PUTs on a local
// receiver (LOAD_FRAMES=1 adds the frames feed). Prints CPU and memory of the media node (Node + mediasoup workers +
// recorder FFmpegs), excluding the replay senders, which are the load generator.
//   pnpm build && node load/run.ts <streams> <seconds> [workers]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { harness } from "./harness.ts";

const STREAMS = Number(process.argv[2] ?? 10);
const SECONDS = Number(process.argv[3] ?? 120);
const WORKERS = Number(process.argv[4] ?? Math.min(cpus().length, 8));
const FIXTURE = join(tmpdir(), "senseplane-load-1080p-2mbps.mp4");

if (!existsSync(FIXTURE)) {
  // 1080p25, 2 Mbps, keyframe every 2 s: a typical camera main stream.
  const enc = process.platform === "darwin" ? ["-c:v", "h264_videotoolbox", "-profile:v", "high"] : ["-c:v", "libopenh264"];
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25", "-t", "30", ...enc,
    "-b:v", "2M", "-maxrate", "2M", "-g", "50", "-pix_fmt", "yuv420p", FIXTURE]);
}

const h = await harness({ workers: WORKERS, segmentSeconds: 6, frames: process.env.LOAD_FRAMES === "1" });
const sources = Array.from({ length: STREAMS }, (_, i) => `src_load${Date.now()}_${i}`);
const cameras = [];
for (const s of sources) cameras.push(await h.camera(s, FIXTURE));

// Sample the process tree every 5 s after a 20 s warm-up.
type Sample = { cpu: number; rssMb: number; recorders: number; workers: number };
const samples: Sample[] = [];
const sample = (): Sample => {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,%cpu=,rss=,command="]).toString().trim().split("\n");
  const rows = out.map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/)!;
    return { pid: +m[1]!, ppid: +m[2]!, cpu: +m[3]!, rss: +m[4]!, cmd: m[5]! };
  });
  const mine = rows.filter((r) => r.pid === process.pid || r.ppid === process.pid);
  const node = mine.filter((r) => !r.cmd.includes("-f rtp")); // drop the replay senders (load generator)
  return {
    cpu: node.reduce((a, r) => a + r.cpu, 0),
    rssMb: Math.round(node.reduce((a, r) => a + r.rss, 0) / 1024),
    recorders: node.filter((r) => r.cmd.includes("-f hls")).length,
    workers: node.filter((r) => r.cmd.includes("mediasoup-worker")).length,
  };
};
const t0 = Date.now();
const timer = setInterval(() => {
  if (Date.now() - t0 > 20_000) samples.push(sample());
}, 5000);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(timer);
for (const c of cameras) await c.stop();
await new Promise((r) => setTimeout(r, 3000));
await h.close();

const segs = h.segments;
const perSource = sources.map((s) => segs.filter((e) => e.source_id === s));
const coverage = perSource.map((list) => list.reduce((a, e) => a + Number(e.duration_ms), 0) / 1000);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
console.log(JSON.stringify({
  machine: `${cpus()[0]?.model} · ${cpus().length} cores · ${Math.round(totalmem() / 2 ** 30)} GB`,
  streams: STREAMS, workers: WORKERS, seconds: SECONDS, input: "1080p25 H.264 2 Mbps",
  mediaNode: {
    cpuPercentAvg: Math.round(avg(samples.map((s) => s.cpu))), cpuPercentMax: Math.round(Math.max(...samples.map((s) => s.cpu))),
    rssMbAvg: Math.round(avg(samples.map((s) => s.rssMb))), recordersRunning: Math.max(...samples.map((s) => s.recorders)),
  },
  recording: {
    segments: segs.length, bytesMB: Math.round(segs.reduce((a, e) => a + Number(e.bytes), 0) / 2 ** 20),
    recordedSecondsPerSourceMin: Math.min(...coverage).toFixed(1), recordedSecondsPerSourceAvg: avg(coverage).toFixed(1),
    sourcesWithNoSegments: perSource.filter((l) => l.length === 0).length,
  },
}, null, 2));
process.exit(0);
