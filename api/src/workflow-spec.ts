// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// What a workflow is (ADR 0072, spec/schemas/workflow.json): a trigger and a
// graph of steps. This file checks a definition (the schema, then the graph:
// unique ids, known references, yes/no edges only from condition and ask,
// every step reachable, no cycles), orders it for the engine, fills in text
// templates and evaluates condition rules. It knows only the step kinds below:
// there is no step that switches a device, and anything else is refused here,
// at save time, and again by the engine before a run starts.
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import workflowSchema from "./generated/workflow.schema.json" with { type: "json" };
import { DAYS } from "./schedule.js";
import { wall } from "./local-time.js";

export const STEP_KINDS = ["condition", "ask", "notify", "speak", "clip", "story", "wait"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
/** Steps whose yes and no edges choose what runs next. */
export const BRANCHING: ReadonlySet<string> = new Set(["condition", "ask"]);
/** Steps that may run again after a failure or a lost claim; speech never does (it plays once or not at all). */
export const RETRY_SAFE: ReadonlySet<string> = new Set(["condition", "ask", "notify", "clip", "story", "wait"]);

export const LIMITS = {
  workflows: 100, steps: 20, edges: 40, sources: 20,
  perMinute: 10, perHour: 120, accountPerHour: 600,
  attempts: 3, inputBytes: 64 * 1024, runDays: 30,
} as const;

export type Position = { x: number; y: number };
export type EventTrigger = { type: "event"; event_types?: string[]; sources?: string[]; watch_id?: string; position?: Position };
export type ScheduleTrigger = { type: "schedule"; every_min?: number; at?: string; days?: string[]; time_zone?: string; position?: Position };
export type WebhookTrigger = { type: "webhook"; position?: Position };
export type WorkflowTrigger = EventTrigger | ScheduleTrigger | WebhookTrigger;

type Base = { id: string; name?: string; position?: Position };
export type Rule = { field: string; op: "eq" | "ne" | "in" | "contains" | "gt" | "gte" | "lt" | "lte" | "exists"; value?: unknown };
export type ConditionStep = Base & { kind: "condition"; match?: "all" | "any"; rules: Rule[] };
export type AskStep = Base & { kind: "ask"; question: string; source?: string; min_confidence?: number };
export type NotifyStep = Base & { kind: "notify"; to: { type: "channel" | "webhook"; id: string }; text: string };
export type SpeakStep = Base & { kind: "speak"; source: string; text: string };
export type ClipStep = Base & { kind: "clip"; before_s?: number; after_s?: number };
export type StoryStep = Base & { kind: "story"; sources?: string[]; before_s?: number; after_s?: number; mode?: "labelled" | "fast" };
export type WaitStep = Base & { kind: "wait"; seconds: number };
export type Step = ConditionStep | AskStep | NotifyStep | SpeakStep | ClipStep | StoryStep | WaitStep;
export type Edge = { from: string; to: string; branch?: "yes" | "no" };
export interface WorkflowDefinition {
  trigger: WorkflowTrigger;
  steps: Step[];
  edges: Edge[];
}
/** What started a run. */
export type WorkflowRunTrigger =
  | { type: "event"; event_id: string; event_type: string }
  | { type: "schedule"; scheduled_for: string }
  | { type: "webhook"; input: Record<string, unknown> }
  | { type: "manual"; by: string; input?: Record<string, unknown> };

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormatsModule as unknown as (a: Ajv2020) => void)(ajv);
ajv.addSchema(workflowSchema);
const validateDefinition = ajv.getSchema(`${(workflowSchema as { $id: string }).$id}#/$defs/workflowDefinition`)!;
const validateStep = ajv.getSchema(`${(workflowSchema as { $id: string }).$id}#/$defs/workflowStep`)!;

export class DefinitionError extends Error {
  constructor(message: string, readonly problems: string[] = [message]) {
    super(message);
  }
}

/** The schema's complaint about a step, plainly: an unknown kind is said as such (there is no control step). */
function stepProblem(step: unknown, i: number): string | undefined {
  const s = step as { kind?: unknown; id?: unknown };
  const where = `steps[${i}]${typeof s?.id === "string" ? ` (${s.id})` : ""}`;
  if (!s || typeof s !== "object") return `${where} must be an object`;
  if (typeof s.kind !== "string" || !(STEP_KINDS as readonly string[]).includes(s.kind)) {
    return `${where}: unknown step kind ${JSON.stringify(s.kind)}; a step is one of ${STEP_KINDS.join(", ")}. No step switches a device.`;
  }
  if (validateStep(step)) return undefined;
  // Only the errors for its own kind's branch of the oneOf.
  const own = (validateStep.errors ?? []).filter((e) => e.schemaPath.includes(`/${s.kind}Step/`) || e.schemaPath.startsWith(`#/$defs/${s.kind}Step`));
  const errs = own.length ? own : validateStep.errors ?? [];
  return `${where}: ${errs.slice(0, 3).map((e) => `${e.instancePath.replace(/^\//, "").replace(/\//g, ".") || s.kind} ${e.message}`).join("; ")}`;
}

const scalarOk = (v: unknown) => (typeof v === "string" && v.length <= 200) || (typeof v === "number" && Number.isFinite(v));
/** What a rule may compare with: a short string, a number, a boolean; for `in`, a list of strings and numbers. */
const ruleValueOk = (v: unknown, list: boolean) =>
  scalarOk(v) || typeof v === "boolean" || (list && Array.isArray(v) && v.length <= 20 && v.every(scalarOk));

/**
 * Checks a definition: the schema, then the graph. Returns it as given; throws DefinitionError listing the
 * problems. `sources` are the workflow's sources: what its trigger and steps name must be among them.
 */
export function checkDefinition(def: unknown, sources: readonly string[]): WorkflowDefinition {
  const problems: string[] = [];
  const d = def as Partial<WorkflowDefinition> | null;
  if (Array.isArray(d?.steps)) d.steps.forEach((s, i) => { const p = stepProblem(s, i); if (p) problems.push(p); });
  if (problems.length) throw new DefinitionError(problems[0]!, problems);
  if (!validateDefinition(def)) {
    const errs = (validateDefinition.errors ?? []).filter((e) => !e.instancePath.startsWith("/steps/"));
    const list = (errs.length ? errs : validateDefinition.errors ?? []).slice(0, 5).map((e) => `${e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "definition"} ${e.message}`);
    throw new DefinitionError(list[0] ?? "the definition is invalid", list);
  }
  const w = def as WorkflowDefinition;
  const ids = new Set<string>();
  for (const s of w.steps) {
    if (s.id === "trigger") problems.push(`steps: "trigger" is the trigger's id; name the step something else`);
    else if (ids.has(s.id)) problems.push(`steps: the id ${s.id} is used twice`);
    ids.add(s.id);
  }
  const inSources = (id: string, what: string) => { if (!sources.includes(id)) problems.push(`${what}: ${id} isn't one of the workflow's sources`); };
  const t = w.trigger;
  if (t.type === "event") for (const id of t.sources ?? []) inSources(id, "trigger.sources");
  if (t.type === "schedule") {
    if ((t.every_min === undefined) === (t.at === undefined)) problems.push("trigger: a schedule needs every_min or at, not both");
  }
  const kinds = new Map(w.steps.map((s) => [s.id, s.kind]));
  for (const s of w.steps) {
    if (s.kind === "ask" && s.source) inSources(s.source, `${s.id}.source`);
    if (s.kind === "speak") inSources(s.source, `${s.id}.source`);
    if (s.kind === "story") for (const id of s.sources ?? []) inSources(id, `${s.id}.sources`);
    if ((s.kind === "clip" || s.kind === "story") && t.type !== "event" && !(s.kind === "story" && s.sources?.length)) {
      problems.push(`${s.id}: a ${s.kind} of "the event's moment" needs an event trigger${s.kind === "story" ? ", or name its sources" : ""}`);
    }
    if (s.kind === "condition") {
      for (const r of s.rules) {
        const m = /^steps\.([a-z][a-z0-9_]*)\./.exec(r.field);
        if (m && kinds.get(m[1]!) !== "ask") problems.push(`${s.id}: ${r.field} names ${m[1]}, which isn't an ask step`);
        if (r.op !== "exists" && r.value === undefined) problems.push(`${s.id}: the rule on ${r.field} needs a value`);
        if (r.value !== undefined && !ruleValueOk(r.value, r.op === "in")) {
          problems.push(`${s.id}: the rule on ${r.field} compares with a string (at most 200 characters), a number or a boolean${r.op === "in" ? ", or a list of at most 20 strings and numbers" : ""}`);
        }
        if (r.field.startsWith("event.") && t.type !== "event") problems.push(`${s.id}: ${r.field} needs an event trigger`);
        if (r.field.startsWith("input.") && t.type !== "webhook") problems.push(`${s.id}: ${r.field} needs a webhook trigger`);
      }
    }
  }
  const seen = new Set<string>();
  for (const e of w.edges) {
    const key = `${e.from}>${e.to}>${e.branch ?? ""}`;
    if (seen.has(key)) problems.push(`edges: ${e.from} → ${e.to} is listed twice`);
    seen.add(key);
    if (e.from !== "trigger" && !kinds.has(e.from)) problems.push(`edges: ${e.from} isn't a step`);
    if (!kinds.has(e.to)) problems.push(`edges: ${e.to} isn't a step`);
    if (e.from === e.to) problems.push(`edges: ${e.from} can't lead to itself`);
    if (e.branch && !BRANCHING.has(kinds.get(e.from) ?? "")) problems.push(`edges: only condition and ask steps have yes and no edges (${e.from} → ${e.to})`);
  }
  if (problems.length) throw new DefinitionError(problems[0]!, problems);
  // Every step reachable from the trigger, and no cycles (Kahn's algorithm over the edges).
  order(w, problems);
  if (problems.length) throw new DefinitionError(problems[0]!, problems);
  return w;
}

/** The steps in an order where every edge goes forward. Adds the problems it finds (a cycle, unreachable steps). */
export function order(w: WorkflowDefinition, problems: string[] = []): Step[] {
  const byId = new Map(w.steps.map((s) => [s.id, s]));
  const edges = w.edges.filter((e) => byId.has(e.to) && (e.from === "trigger" || byId.has(e.from)));
  // Reachable from the trigger.
  const reach = new Set<string>(["trigger"]);
  const queue = ["trigger"];
  while (queue.length) {
    const at = queue.shift()!;
    for (const e of edges) if (e.from === at && !reach.has(e.to)) { reach.add(e.to); queue.push(e.to); }
  }
  const unreachable = w.steps.filter((s) => !reach.has(s.id)).map((s) => s.id);
  if (unreachable.length) problems.push(`steps not connected to the trigger: ${unreachable.join(", ")}`);
  // Kahn's algorithm from the trigger: what is left over sits on (or after) a cycle.
  const indeg = new Map(w.steps.map((s) => [s.id, 0]));
  for (const e of edges) indeg.set(e.to, indeg.get(e.to)! + 1);
  const ready = ["trigger", ...w.steps.filter((s) => indeg.get(s.id) === 0 && reach.has(s.id)).map((s) => s.id)];
  const out: Step[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    if (id !== "trigger") out.push(byId.get(id)!);
    for (const e of edges) {
      if (e.from !== id) continue;
      const n = indeg.get(e.to)! - 1;
      indeg.set(e.to, n);
      if (n === 0) ready.push(e.to);
    }
  }
  const left = w.steps.filter((s) => reach.has(s.id) && !out.includes(s));
  if (left.length) problems.push(`the steps loop back on themselves: ${left.map((s) => s.id).join(", ")}; a workflow can't have a cycle`);
  return out;
}

// --- what steps see ----------------------------------------------------------------------

/** What a run's steps can read: the event, the webhook input, ask answers, and the time. */
export interface RunContext {
  event?: { id: string; type: string; source_id: string; source_name: string; sense: string; summary: string; labels: string[]; confidence: number | null; verified: boolean | null; reading: number | null; occurred_at: string };
  input?: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
  /** The run's start, and the zone for time.hour and time.weekday. */
  at: number;
  timeZone: string;
}

function lookup(ctx: RunContext, path: string): unknown {
  const [head, ...rest] = path.split(".");
  if (head === "time") {
    const w = wall(ctx.at, ctx.timeZone);
    return rest[0] === "hour" ? w.hh : rest[0] === "weekday" ? DAYS[w.dow] : undefined;
  }
  let v: unknown = head === "event" ? ctx.event : head === "input" ? ctx.input : head === "steps" ? ctx.steps : undefined;
  for (const k of rest) {
    if (v === null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/** Fills in {{event.summary}}, {{input.name}}, {{steps.check.answer}}…; anything unknown becomes empty. Nothing is evaluated. */
export function fillTemplate(text: string, ctx: RunContext, max = 1000): string {
  return text.replace(/\{\{\s*([a-z_]+(?:\.[A-Za-z0-9_]+){0,3})\s*\}\}/g, (_, path: string) => {
    const v = lookup(ctx, path);
    if (v === undefined || v === null) return "";
    return (typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, 500);
  }).slice(0, max);
}

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const same = (a: unknown, b: unknown) => a === b || (typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase()) || (num(a) !== undefined && num(a) === num(b));

export function ruleHolds(r: Rule, ctx: RunContext): boolean {
  const v = lookup(ctx, r.field);
  switch (r.op) {
    case "exists": return v !== undefined && v !== null && v !== "";
    case "eq": return Array.isArray(v) ? v.some((x) => same(x, r.value)) : same(v, r.value);
    case "ne": return Array.isArray(v) ? !v.some((x) => same(x, r.value)) : !same(v, r.value);
    case "in": return Array.isArray(r.value) && (Array.isArray(v) ? v.some((x) => (r.value as unknown[]).some((y) => same(x, y))) : (r.value as unknown[]).some((y) => same(v, y)));
    case "contains":
      if (Array.isArray(v)) return v.some((x) => same(x, r.value));
      return typeof v === "string" && typeof r.value === "string" && v.toLowerCase().includes(r.value.toLowerCase());
    default: {
      const a = num(v);
      const b = num(r.value);
      if (a === undefined || b === undefined) return false;
      return r.op === "gt" ? a > b : r.op === "gte" ? a >= b : r.op === "lt" ? a < b : a <= b;
    }
  }
}

export function conditionHolds(s: ConditionStep, ctx: RunContext): boolean {
  return s.match === "any" ? s.rules.some((r) => ruleHolds(r, ctx)) : s.rules.every((r) => ruleHolds(r, ctx));
}

/** The sources a definition's steps speak through: the only cameras a run gets a speak grant on. */
export const speakTargets = (w: WorkflowDefinition) => [...new Set(w.steps.flatMap((s) => (s.kind === "speak" ? [s.source] : [])))];
