// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { reactTo } from "./events";

it("stops without reconnecting when the camera is opened on another device", () => {
  expect(reactTo({ event: "roomClosed", reason: "replaced" })).toEqual({ action: "stop", message: "This camera was opened on another device" });
});

it("reconnects only when the node is draining, and ignores unknown events", () => {
  expect(reactTo({ event: "draining", reconnectAfterMs: 2500 })).toMatchObject({ action: "reconnect", afterMs: 2500 });
  expect(reactTo({ event: "roomClosed", reason: "x" }).action).toBe("stop");
  expect(reactTo({ event: "roomClosed", reason: "allowance_exhausted" })).toMatchObject({ action: "stop", message: expect.stringContaining("used its camera time") });
  expect(reactTo({ event: "somethingNew" })).toEqual({ action: "ignore" });
});
