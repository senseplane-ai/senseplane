// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { fitsResolution } from "./egress/segments.js";
import { parseEgressStart } from "./egress/validate.js";

const start = (frames: Record<string, unknown>) =>
  parseEgressStart({ sessionId: "s1", room: "sp-src", joinToken: "t", sinks: [{ kind: "frames", ...frames }], callback: { url: "http://api/cb", token: "b" } });

it("takes a frames sink's batchMs within 100–1000 and leaves it unset otherwise", () => {
  expect(start({ batchMs: 200 }).sinks[0]).toEqual({ kind: "frames", batchMs: 200 });
  expect(start({}).sinks[0]).toEqual({ kind: "frames" });
  for (const batchMs of [50, 1001, 250.5, "200"]) expect(() => start({ batchMs }), String(batchMs)).toThrow(/batchMs must be 100–1000/);
});

const segments = (maxResolution: unknown) =>
  parseEgressStart({ sessionId: "s1", room: "sp-src", joinToken: "t", sinks: [{ kind: "segments", keyPrefix: "a/", destination: { type: "presign-callback" }, maxResolution }], callback: { url: "http://api/cb", token: "b" } });

it("takes a 1440p limit, for cameras that only send 2K or 3 MP, and checks it by long and short side", () => {
  expect(segments("1440p").sinks[0]).toMatchObject({ kind: "segments", maxResolution: "1440p" });
  expect(() => segments("4k")).toThrow(/720p, 1080p or 1440p/);
  expect(fitsResolution(2304, 1296, "1080p")).toBe(false);
  expect(fitsResolution(2304, 1296, "1440p")).toBe(true);
  expect(fitsResolution(1440, 2560, "1440p")).toBe(true);
  expect(fitsResolution(2688, 1520, "1440p")).toBe(false);
});
