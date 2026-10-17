// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { parseEgressStart } from "./egress/validate.js";

const start = (frames: Record<string, unknown>) =>
  parseEgressStart({ sessionId: "s1", room: "sp-src", joinToken: "t", sinks: [{ kind: "frames", ...frames }], callback: { url: "http://api/cb", token: "b" } });

it("takes a frames sink's batchMs within 100–1000 and leaves it unset otherwise", () => {
  expect(start({ batchMs: 200 }).sinks[0]).toEqual({ kind: "frames", batchMs: 200 });
  expect(start({}).sinks[0]).toEqual({ kind: "frames" });
  for (const batchMs of [50, 1001, 250.5, "200"]) expect(() => start({ batchMs }), String(batchMs)).toThrow(/batchMs must be 100–1000/);
});
