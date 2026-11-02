// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { isSensorSense, readingText, senseInfo, senseName, stateWord, unitSymbol } from "./index.js";

describe("sensor senses (ADR 0060)", () => {
  it("knows each sense's kind, unit and words", () => {
    expect(senseInfo("power")).toMatchObject({ kind: "number", unit: "watt" });
    expect(senseInfo("contact")).toMatchObject({ kind: "state", on: "open", off: "closed" });
    expect(senseInfo("doorbell")).toMatchObject({ kind: "event" });
    expect(senseInfo("soil_moisture")).toBeUndefined();
    expect(senseName("contact")).toBe("door or window");
    expect(senseName("soil_moisture")).toBe("soil moisture");
    expect(stateWord("lock", true)).toBe("unlocked");
    expect(stateWord("mailbox", false)).toBe("off");
    expect(unitSymbol("ugm3")).toBe("µg/m³");
    expect(isSensorSense("audio")).toBe(false);
    expect(isSensorSense("leak")).toBe(true);
  });

  it("words readings", () => {
    expect(readingText({ sense: "temperature", kind: "number", value: 21.46, unit: "celsius" })).toBe("21.5 °C");
    expect(readingText({ sense: "humidity", value: 40, unit: "percent" })).toBe("40%");
    expect(readingText({ sense: "contact", kind: "state", value: true })).toBe("open");
    expect(readingText({ sense: "contact", kind: "state", value: false, state: "closed" })).toBe("closed");
    expect(readingText({ sense: "button", kind: "event", detail: "double" })).toBe("pressed (double)");
    expect(readingText({ sense: "doorbell", kind: "event" })).toBe("rang");
  });
});
