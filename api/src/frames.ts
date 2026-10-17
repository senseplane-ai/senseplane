// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The frames batch (spec/media/callbacks.json framesBatch) on its way to the
// camera's brain. Privacy masks are applied here, before any pixel leaves the
// API: a frame of a source with masks is decoded, blacked out and encoded
// again; a frame of a source without masks passes through untouched.
import jpeg from "jpeg-js";
import type { DataAccess } from "./data/access.js";
import { rasterise } from "./masks.js";

export const FRAME_W = 640;
export const FRAME_H = 360;

/** Blacks out masked pixels in a JPEG (RGBA decode, alpha kept). */
export function maskJpeg(input: Buffer, mask: Uint8Array): Buffer {
  const img = jpeg.decode(input, { useTArray: true, maxMemoryUsageInMB: 64 });
  if (img.width !== FRAME_W || img.height !== FRAME_H) {
    // Not the contract's box: mask in its own size rather than not at all.
    const m = rasteriseCache(img.width, img.height, mask);
    return applyAndEncode(img, m);
  }
  return applyAndEncode(img, mask);
}

let lastPolys: { w: number; h: number; src: Uint8Array; out: Uint8Array } | undefined;
function rasteriseCache(w: number, h: number, mask640: Uint8Array): Uint8Array {
  if (lastPolys && lastPolys.w === w && lastPolys.h === h && lastPolys.src === mask640) return lastPolys.out;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = mask640[Math.min(FRAME_H - 1, Math.floor((y * FRAME_H) / h)) * FRAME_W + Math.min(FRAME_W - 1, Math.floor((x * FRAME_W) / w))]!;
  }
  lastPolys = { w, h, src: mask640, out };
  return out;
}

function applyAndEncode(img: { width: number; height: number; data: Uint8Array }, mask: Uint8Array): Buffer {
  const d = img.data;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    d[o] = 0;
    d[o + 1] = 0;
    d[o + 2] = 0;
  }
  return jpeg.encode({ width: img.width, height: img.height, data: d }, 80).data;
}

/** Each source's mask (640x360), cached briefly; dropped at once when its config changes. */
export class MaskCache {
  private readonly entries = new Map<string, { at: number; mask?: Uint8Array }>();
  constructor(private readonly data: DataAccess, private readonly ttlMs = 5000) {}

  invalidate(key: string) {
    this.entries.delete(key);
  }

  async get(accountId: string, sourceId: string): Promise<Uint8Array | undefined> {
    const key = `${accountId}.${sourceId}`;
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.mask;
    const src = await this.data.withAccount(accountId, (s) => s.sources.get(sourceId));
    const mask = rasterise((src?.privacy_masks as number[][][] | undefined) ?? [], FRAME_W, FRAME_H);
    this.entries.set(key, { at: Date.now(), mask });
    if (this.entries.size > 10_000) this.entries.delete(this.entries.keys().next().value!);
    return mask;
  }
}

export interface FramesMeta {
  frames?: { part: string; captured_at: string; width?: number; height?: number; format?: string }[];
  audio?: { part: string; captured_at: string; sample_rate?: number; samples?: number; format?: string };
}

/**
 * Masks and forwards one batch. `publish` sends one item to the camera's
 * brain; it answers false when no brain is alive (the batch is then dropped:
 * a late frame is worth nothing).
 */
export async function forwardFrames(
  form: FormData, meta: FramesMeta, mask: Uint8Array | undefined,
  publish: (kind: "frame" | "audio", meta: Record<string, unknown>, data: Buffer) => Promise<boolean>,
): Promise<{ frames: number; audio: boolean }> {
  let frames = 0;
  for (const f of meta.frames ?? []) {
    const part = form.get(f.part);
    if (!(part instanceof Blob)) continue;
    let body: Buffer = Buffer.from(await part.arrayBuffer());
    if (mask) body = maskJpeg(body, mask);
    if (!(await publish("frame", { captured_at: f.captured_at, width: f.width ?? FRAME_W, height: f.height ?? FRAME_H, format: "jpeg", masked: Boolean(mask) }, body))) return { frames, audio: false };
    frames++;
  }
  const a = meta.audio;
  const audioPart = a ? form.get(a.part) : null;
  if (a && audioPart instanceof Blob) {
    const body = Buffer.from(await audioPart.arrayBuffer());
    await publish("audio", { captured_at: a.captured_at, sample_rate: 16000, samples: a.samples ?? body.length / 4, format: "f32le_mono" }, body);
    return { frames, audio: true };
  }
  return { frames, audio: false };
}
