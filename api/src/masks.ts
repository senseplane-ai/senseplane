// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

/** Normalised polygon ([x, y] in 0–1) → pixel mask for a width×height frame (even-odd fill). */
export function rasterise(polygons: number[][][], width: number, height: number): Uint8Array | undefined {
  if (!polygons.length) return undefined;
  const mask = new Uint8Array(width * height);
  for (const poly of polygons) {
    const pts = poly.map(([x, y]) => [x! * width, y! * height] as const);
    for (let y = 0; y < height; y++) {
      const cy = y + 0.5;
      const xs: number[] = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!;
        const [xj, yj] = pts[j]!;
        if (yi > cy !== yj > cy) xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil(xs[k]! - 0.5));
        const to = Math.min(width - 1, Math.floor(xs[k + 1]! - 0.5));
        if (to >= from) mask.fill(1, y * width + from, y * width + to + 1);
      }
    }
  }
  return mask;
}

/** Blacks out masked pixels in an rgb24 frame, in place. */
export function applyMask(rgb: Uint8Array, mask: Uint8Array | undefined) {
  if (!mask) return;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      const o = i * 3;
      rgb[o] = 0;
      rgb[o + 1] = 0;
      rgb[o + 2] = 0;
    }
  }
}
