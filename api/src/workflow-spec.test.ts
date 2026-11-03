// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Workflow definitions (ADR 0072): the closed list of step kinds (no control
// step, in the schema or in the code), the graph checks (DAG, references,
// branches), conditions and templates.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type RunContext, type WorkflowDefinition, DefinitionError, STEP_KINDS, checkDefinition, conditionHolds, fillTemplate, order } from "./workflow-spec.js";

const SRC = ["src_a", "src_b"];
const base = (): WorkflowDefinition => ({
  trigger: { type: "event", event_types: ["detection.person"] },
  steps: [
    { id: "check", kind: "condition", rules: [{ field: "event.labels", op: "contains", value: "person" }] },
    { id: "look", kind: "ask", question: "Is someone carrying a parcel?" },
    { id: "tell", kind: "notify", to: { type: "webhook", id: "whk_1" }, text: "{{event.summary}}" },
    { id: "say", kind: "speak", source: "src_a", text: "Please leave it by the gate." },
  ],
  edges: [
    { from: "trigger", to: "check" },
    { from: "check", to: "look", branch: "yes" },
    { from: "look", to: "say", branch: "yes" },
    { from: "look", to: "tell", branch: "no" },
  ],
});
const problems = (def: unknown, sources = SRC) => {
  try {
    checkDefinition(def, sources);
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(DefinitionError);
    return (err as DefinitionError).problems;
  }
};

describe("no step can switch a device", () => {
  it("has a closed list of step kinds without control", () => {
    expect([...STEP_KINDS]).toEqual(["condition", "ask", "notify", "speak", "clip", "story", "wait"]);
    expect(STEP_KINDS as readonly string[]).not.toContain("control");
  });
  it("leaves control out of the spec's schema: every step is one of the known kinds, and nothing else validates", () => {
    const schema = JSON.parse(readFileSync(new URL("../../spec/schemas/workflow.json", import.meta.url), "utf8"));
    const kinds = schema.$defs.step.oneOf.map((r: { $ref: string }) => schema.$defs[r.$ref.split("/").pop()!].properties.kind.const);
    expect(kinds).toEqual([...STEP_KINDS]);
    for (const def of Object.values(schema.$defs) as { additionalProperties?: boolean; properties?: Record<string, unknown> }[]) {
      if (def.properties?.kind) expect(def.additionalProperties).toBe(false);
    }
    // The copy the API validates with is the spec's.
    expect(readFileSync(new URL("./generated/workflow.schema.json", import.meta.url), "utf8")).toBe(readFileSync(new URL("../../spec/schemas/workflow.json", import.meta.url), "utf8"));
  });
  it("refuses a control step, or any unknown kind, wherever it is", () => {
    for (const kind of ["control", "device_control", "switch", "turn_on", "http", ""]) {
      const def = base();
      (def.steps as unknown[]).push({ id: "flip", kind, device: "dev_1", action: "turn_on" });
      def.edges.push({ from: "check", to: "flip", branch: "no" });
      const p = problems(def);
      expect(p[0]).toContain(`unknown step kind ${JSON.stringify(kind)}`);
      expect(p[0]).toContain("No step switches a device");
    }
    // A known kind can't carry a device action either: extra fields are refused.
    const def = base();
    (def.steps[3] as unknown as Record<string, unknown>).device = "dev_1";
    expect(problems(def)[0]).toMatch(/say.*must NOT have additional properties/);
  });
});

describe("checking a definition", () => {
  it("accepts a well-formed DAG and orders it so every edge goes forward", () => {
    const def = checkDefinition(base(), SRC);
    const ids = order(def).map((s) => s.id);
    expect(ids[0]).toBe("check");
    for (const e of def.edges) if (e.from !== "trigger") expect(ids.indexOf(e.from)).toBeLessThan(ids.indexOf(e.to));
  });
  it("refuses cycles, self-loops and steps the trigger never reaches", () => {
    const cycle = base();
    cycle.edges.push({ from: "say", to: "check" });
    expect(problems(cycle).join()).toMatch(/loop back on themselves: check, look, tell, say; a workflow can.t have a cycle/);
    const self = base();
    self.edges.push({ from: "tell", to: "tell" });
    expect(problems(self).join()).toMatch(/tell can't lead to itself/);
    const island = base();
    island.edges = island.edges.filter((e) => e.to !== "tell");
    expect(problems(island).join()).toMatch(/not connected to the trigger: tell/);
    // Two steps that only lead to each other are unreachable and a cycle: said as unreachable.
    const pair = base();
    pair.steps.push({ id: "w1", kind: "wait", seconds: 5 }, { id: "w2", kind: "wait", seconds: 5 });
    pair.edges.push({ from: "w1", to: "w2" }, { from: "w2", to: "w1" });
    expect(problems(pair).join()).toMatch(/not connected to the trigger: w1, w2/);
  });
  it("refuses bad references, duplicate ids and branches from steps that don't branch", () => {
    const dup = base();
    dup.steps.push({ id: "check", kind: "wait", seconds: 1 });
    expect(problems(dup).join()).toMatch(/check is used twice/);
    const trig = base();
    trig.steps.push({ id: "trigger", kind: "wait", seconds: 1 });
    expect(problems(trig).join()).toMatch(/"trigger" is the trigger's id/);
    const ghost = base();
    ghost.edges.push({ from: "look", to: "nowhere" });
    expect(problems(ghost).join()).toMatch(/nowhere isn't a step/);
    const twice = base();
    twice.edges.push({ from: "trigger", to: "check" });
    expect(problems(twice).join()).toMatch(/listed twice/);
    const branchy = base();
    branchy.edges.push({ from: "tell", to: "say", branch: "yes" });
    expect(problems(branchy).join()).toMatch(/only condition and ask steps have yes and no edges/);
  });
  it("keeps every source a step or trigger names inside the workflow's own sources", () => {
    const def = base();
    (def.steps[3] as { source: string }).source = "src_elsewhere";
    expect(problems(def).join()).toMatch(/say.source: src_elsewhere isn't one of the workflow's sources/);
    const trig = base();
    trig.trigger = { type: "event", sources: ["src_c"] };
    expect(problems(trig).join()).toMatch(/trigger.sources: src_c/);
  });
  it("checks the trigger and the fields rules read", () => {
    expect(problems({ ...base(), trigger: { type: "schedule" } }).join()).toMatch(/every_min or at/);
    expect(problems({ ...base(), trigger: { type: "schedule", every_min: 5, at: "08:00" } }).join()).toMatch(/every_min or at/);
    expect(problems({ ...base(), trigger: { type: "schedule", every_min: 2 } }).join()).toMatch(/every_min must be >= 5/);
    const clipNoEvent = { trigger: { type: "webhook" }, steps: [{ id: "c", kind: "clip" }], edges: [{ from: "trigger", to: "c" }] };
    expect(problems(clipNoEvent).join()).toMatch(/needs an event trigger/);
    const inputOnEvent = base();
    inputOnEvent.steps[0] = { id: "check", kind: "condition", rules: [{ field: "input.door", op: "eq", value: "front" }] };
    expect(problems(inputOnEvent).join()).toMatch(/input.door needs a webhook trigger/);
    const notAsk = base();
    notAsk.steps[0] = { id: "check", kind: "condition", rules: [{ field: "steps.tell.answer", op: "exists" }] };
    expect(problems(notAsk).join()).toMatch(/isn't an ask step/);
    expect(problems({ ...base(), steps: [] }).join()).toMatch(/steps must NOT have fewer than 1 items/);
    const many = base();
    for (let i = 0; i < 20; i++) many.steps.push({ id: `w${i}`, kind: "wait", seconds: 1 });
    expect(problems(many).join()).toMatch(/steps must NOT have more than 20 items/);
  });
});

describe("what steps read", () => {
  const ctx: RunContext = {
    event: { id: "evt_1", type: "detection.person", source_id: "src_a", source_name: "Porch", sense: "video", summary: "Someone at the door", labels: ["person", "package"], confidence: 0.82, verified: true, reading: null, occurred_at: "2026-11-03T21:30:00.000Z" },
    input: { door: "front", count: "3" },
    steps: { look: { yes: true, answer: "Yes, a brown box", confidence: 0.9 } },
    at: Date.parse("2026-11-03T21:30:00Z"), timeZone: "Europe/London",
  };
  it("fills in templates and nothing else", () => {
    expect(fillTemplate("{{event.source_name}}: {{event.summary}} ({{steps.look.answer}}) {{input.door}} {{nope.x}}{{ event.labels }}", ctx))
      .toBe('Porch: Someone at the door (Yes, a brown box) front ["person","package"]');
    expect(fillTemplate("{{constructor.constructor}}{{event.__proto__}}", ctx)).toBe("");
    expect(fillTemplate("x".repeat(2000), ctx)).toHaveLength(1000);
  });
  it("evaluates rules: all or any, numbers, lists, time in the workspace's zone", () => {
    const cond = (rules: { field: string; op: string; value?: unknown }[], match?: "any") => conditionHolds({ id: "c", kind: "condition", rules, ...(match ? { match } : {}) } as never, ctx);
    expect(cond([{ field: "event.labels", op: "contains", value: "package" }, { field: "event.confidence", op: "gte", value: 0.8 }])).toBe(true);
    expect(cond([{ field: "event.labels", op: "contains", value: "car" }, { field: "event.confidence", op: "gte", value: 0.8 }])).toBe(false);
    expect(cond([{ field: "event.labels", op: "contains", value: "car" }, { field: "event.confidence", op: "gte", value: 0.8 }], "any")).toBe(true);
    expect(cond([{ field: "input.count", op: "gt", value: 2 }])).toBe(true);
    expect(cond([{ field: "input.door", op: "in", value: ["back", "FRONT"] }])).toBe(true);
    expect(cond([{ field: "input.missing", op: "exists" }])).toBe(false);
    expect(cond([{ field: "steps.look.yes", op: "eq", value: true }])).toBe(true);
    expect(cond([{ field: "time.hour", op: "eq", value: 21 }, { field: "time.weekday", op: "eq", value: "tue" }])).toBe(true);
    expect(cond([{ field: "event.type", op: "ne", value: "detection.person" }])).toBe(false);
  });
});
