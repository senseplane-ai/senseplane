// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Accelerated leak check: many cameras, 1 s segments and the frames feed,
// sampling the Node heap.
//   pnpm build && node --expose-gc load/leak.ts <streams> <minutes>
import { harness } from "./harness.ts";

const STREAMS = Number(process.argv[2] ?? 20);
const MINUTES = Number(process.argv[3] ?? 5);
const FIXTURE = new URL("../../fixtures/testsrc-h264-640x360-20s.mp4", import.meta.url).pathname;
const h = await harness({ workers: 2, segmentSeconds: 1, frames: true });
for (let i = 0; i < STREAMS; i++) await h.camera(`src_leak${i}`, FIXTURE);
const samples: { min: number; heapMb: number; rssMb: number; events: number }[] = [];
const t0 = Date.now();
while (Date.now() - t0 < MINUTES * 60_000) {
  await new Promise((r) => setTimeout(r, 30_000));
  h.segments.length = 0; // the test receiver itself must not count as a leak
  (globalThis as { gc?: () => void }).gc?.();
  const m = process.memoryUsage();
  samples.push({ min: Number(((Date.now() - t0) / 60_000).toFixed(1)), heapMb: Math.round(m.heapUsed / 2 ** 20), rssMb: Math.round(m.rss / 2 ** 20), events: h.events() });
  console.log(JSON.stringify(samples.at(-1)));
}
await h.close();
process.exit(0);
