// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Event type patterns (detection.* for every detector label) and the label
// enums that repeat spec/labels.json. Pure: needs no database.
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { routeEvent, typeFilter, typeMatches } from "./events.js";

const spec = (p: string) => JSON.parse(readFileSync(new URL(`../../spec/${p}`, import.meta.url), "utf8"));
const labels: string[] = spec("labels.json").labels.map((l: { label: string }) => l.label);

describe("event type patterns", () => {
  it("matches a type exactly, everything, or a prefix wildcard", () => {
    expect(typeMatches("detection.person", "detection.person")).toBe(true);
    expect(typeMatches("detection.person", "detection.cup")).toBe(false);
    expect(typeMatches("*", "sound.detected")).toBe(true);
    expect(typeMatches("detection.*", "detection.cup")).toBe(true);
    expect(typeMatches("detection.*", "detection.person")).toBe(true);
    expect(typeMatches("detection.*", "sound.detected")).toBe(false);
    expect(typeMatches("detection.*", "detection")).toBe(false);
  });

  it("routes object detections to detection.* and exact subscribers, not to others", () => {
    const hooks = [{ id: "a", events: ["detection.person"] }, { id: "b", events: ["detection.*"] }, { id: "c", events: ["detection.cup"] }, { id: "d", events: ["*"] }];
    expect(routeEvent("detection.cup", null, hooks).webhooks).toEqual(["b", "c", "d"]);
    expect(routeEvent("detection.person", null, hooks).webhooks).toEqual(["a", "b", "d"]);
  });

  it("turns a prefix wildcard into LIKE with the prefix escaped", () => {
    expect(typeFilter("detection.cup")).toEqual({ op: "=", value: "detection.cup" });
    expect(typeFilter("detection.*")).toEqual({ op: "like", value: "detection.%" });
    expect(typeFilter("source_x.*")).toEqual({ op: "like", value: "source\\_x.%" });
  });
});

describe("detector labels", () => {
  it("keeps person, vehicle and animal and adds every other COCO class", () => {
    expect(labels.slice(0, 3)).toEqual(["person", "vehicle", "animal"]);
    expect(labels).toEqual(expect.arrayContaining(["cup", "laptop", "phone", "backpack", "chair", "book", "tv", "couch", "table", "plant"]));
    expect(labels.length).toBe(67);
  });

  it("the objects trigger the API validates accepts every label and nothing else", () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(JSON.parse(readFileSync(new URL("./generated/trigger.schema.json", import.meta.url), "utf8")));
    for (const label of labels) expect(validate({ type: "objects", label, on: "stationary" }), label).toBe(true);
    expect(validate({ type: "objects", label: "mug", on: "present" })).toBe(false);
  });

  it("every label has its detection.<label> event type", () => {
    const types: string[] = spec("schemas/event.json").properties.type.enum;
    for (const label of labels) expect(types).toContain(`detection.${label}`);
    expect(types).toEqual(expect.arrayContaining(["watch.triggered", "sound.detected", "source.view_changed"]));
  });
});
