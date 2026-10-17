// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LABELS, type Label, type Trigger, detectionLabel, isLabel, labelName } from "./index.js";

const spec = JSON.parse(readFileSync(new URL("../../../spec/labels.json", import.meta.url), "utf8")) as { labels: { label: string; name: string }[] };

describe("detector labels", () => {
  it("are spec/labels.json, in order", () => {
    expect(LABELS.map((l) => [l.label, l.name])).toEqual(spec.labels.map((l) => [l.label, l.name]));
    expect(LABELS.filter((l) => "group" in l).map((l) => l.label)).toEqual(["person", "vehicle", "animal"]);
  });

  it("have readable names", () => {
    expect(labelName("cup")).toBe("Cup");
    expect(labelName("teddy_bear")).toBe("Teddy bear");
    expect(labelName("tv")).toBe("TV");
    expect(labelName("glass_break")).toBe("Glass break"); // not a label: words
    expect(detectionLabel("detection.laptop")).toBe("laptop");
    expect(detectionLabel("watch.triggered")).toBeNull();
    expect(isLabel("phone")).toBe(true);
    expect(isLabel("mug")).toBe(false);
  });

  it("type the objects trigger", () => {
    const label: Label = "backpack";
    const t: Trigger = { type: "objects", label, on: "stationary", min_duration_s: 600 };
    expect(t).toMatchObject({ label: "backpack" });
  });
});
