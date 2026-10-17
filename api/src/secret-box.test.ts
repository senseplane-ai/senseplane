// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { createSecretBox } from "./secret-box.js";

describe("secret box", () => {
  const box = createSecretBox("k".repeat(40));
  it("round-trips, uses a fresh IV each time and passes plain values through", () => {
    const a = box.encrypt("whsec_abc");
    expect(a).toMatch(/^enc:v1:/);
    expect(box.encrypt("whsec_abc")).not.toBe(a);
    expect(box.decrypt(a)).toBe("whsec_abc");
    expect(box.decrypt("whsec_plain")).toBe("whsec_plain");
  });
  it("rejects tampering and the wrong key, and short keys", () => {
    const a = box.encrypt("whsec_abc");
    expect(() => box.decrypt(a.slice(0, -2) + "AA")).toThrow();
    expect(() => createSecretBox("x".repeat(40)).decrypt(a)).toThrow();
    expect(() => createSecretBox("short")).toThrow(/at least 32/);
  });
});
