// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { canRetry, reactTo, retryDelay } from "./events";

it("stops without reconnecting when the camera is opened on another device", () => {
  expect(reactTo({ event: "roomClosed", reason: "replaced" })).toEqual({ action: "stop", message: "This camera was opened on another device" });
});

it("reconnects only when the node is draining, and ignores unknown events", () => {
  expect(reactTo({ event: "draining", reconnectAfterMs: 2500 })).toMatchObject({ action: "reconnect", afterMs: 2500 });
  expect(reactTo({ event: "roomClosed", reason: "x" }).action).toBe("stop");
  expect(reactTo({ event: "roomClosed", reason: "allowance_exhausted" })).toMatchObject({ action: "stop", message: expect.stringContaining("used its camera time") });
  expect(reactTo({ event: "somethingNew" })).toEqual({ action: "ignore" });
});

it("waits longer after each failed reconnect, up to 30 s, with jitter", () => {
  expect([0, 1, 2, 3, 4, 5, 9].map((n) => retryDelay(n, () => 1))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  expect(retryDelay(0, () => 0)).toBe(500);
});

it("retries when the server or network was away, not when the server said no", () => {
  expect(canRetry(new TypeError("Failed to fetch"))).toBe(true);
  expect(canRetry({ code: "unreachable" })).toBe(true);
  expect(canRetry({ code: "closed" })).toBe(true);
  expect(canRetry({ status: 503 })).toBe(true);
  expect(canRetry({ status: 502 })).toBe(true);
  expect(canRetry({ status: 401 })).toBe(false); // a revoked link
  expect(canRetry({ status: 409, code: "source_limit_reached" })).toBe(false);
  expect(canRetry({ code: "allowance_exhausted" })).toBe(false);
  expect(canRetry(new Error("This browser cannot send H.264 video."))).toBe(false);
});
