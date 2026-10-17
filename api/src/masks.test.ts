// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { applyMask, rasterise } from "./masks.js";

it("blacks out exactly the masked area", () => {
  const w = 10, h = 10;
  const mask = rasterise([[[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]], w, h)!;
  expect(mask.reduce((a, b) => a + b, 0)).toBe(25);
  const rgb = new Uint8Array(w * h * 3).fill(200);
  applyMask(rgb, mask);
  expect(rgb[0]).toBe(0); // top-left masked
  expect(rgb[(9 * w + 9) * 3]).toBe(200); // bottom-right untouched
  expect(rasterise([], w, h)).toBeUndefined();
});
