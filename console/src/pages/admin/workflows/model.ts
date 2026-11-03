// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Workflows in the console (ADR 0072): the step palette, new steps, what a
// step says in a line, and the graph rules the editor keeps as you draw (no
// loops, yes/no only from condition and ask). The API checks everything again.
// The palette is the spec's closed list of steps: none switches a device.
import type { WorkflowEdge, WorkflowStep, WorkflowTrigger } from "senseplane";

export type Step = WorkflowStep;
export type Trigger = WorkflowTrigger;
export type Edge = WorkflowEdge;
export type Kind = Step["kind"];
export interface Definition {
  trigger: Trigger;
  steps: Step[];
  edges: Edge[];
}
export type Position = { x: number; y: number };

/** The steps a workflow can have. There is no step that switches a device. */
export const PALETTE: { kind: Kind; label: string; hint: string }[] = [
  { kind: "condition", label: "Condition", hint: "Go on only when rules hold (yes / no)" },
  { kind: "ask", label: "Ask", hint: "Ask the vision model about the moment (yes / no)" },
  { kind: "notify", label: "Notify", hint: "Tell a chat or a webhook (n8n, Zapier, Home Assistant)" },
  { kind: "speak", label: "Speak", hint: "Say something through a camera's speaker" },
  { kind: "clip", label: "Clip", hint: "Save a clip of the moment" },
  { kind: "story", label: "Story", hint: "Make a story of the moment across cameras" },
  { kind: "wait", label: "Wait", hint: "Pause before the next step" },
];
export const BRANCHING: ReadonlySet<string> = new Set(["condition", "ask"]);
export const LIMITS = { steps: 20, edges: 40, sources: 20 };
export const kindLabel = (k: string) => PALETTE.find((p) => p.kind === k)?.label ?? k;

/** A fresh id for a step of this kind: condition, condition_2, … */
export function freshId(kind: string, taken: Iterable<string>): string {
  const ids = new Set(taken);
  if (!ids.has(kind)) return kind;
  for (let n = 2; ; n++) if (!ids.has(`${kind}_${n}`)) return `${kind}_${n}`;
}

export function newStep(kind: Kind, def: Definition, ctx: { camera?: string; speaker?: string; webhook?: string; channel?: string }, position?: Position): Step {
  const id = freshId(kind, def.steps.map((s) => s.id));
  const at = position ? { position } : {};
  switch (kind) {
    case "condition": return { id, kind, rules: [{ field: def.trigger.type === "webhook" ? "input.value" : "event.labels", op: "contains", value: "person" }], ...at };
    case "ask": return { id, kind, question: "Is someone carrying a parcel?", ...at };
    case "notify": return {
      id, kind, to: ctx.channel ? { type: "channel", id: ctx.channel } : { type: "webhook", id: ctx.webhook ?? "" },
      text: def.trigger.type === "event" ? "{{event.source_name}}: {{event.summary}}" : "Workflow ran", ...at,
    };
    case "speak": return { id, kind, source: ctx.speaker ?? ctx.camera ?? "", text: "Hello, this is an automated message.", ...at };
    case "clip": return { id, kind, ...at };
    case "story": return { id, kind, ...at };
    case "wait": return { id, kind, seconds: 60, ...at };
  }
}

export const defaultTrigger = (type: Trigger["type"]): Trigger =>
  type === "event" ? { type, event_types: ["detection.person"] } : type === "schedule" ? { type, at: "08:00" } : { type };

export const blankDefinition = (): Definition => ({ trigger: defaultTrigger("event"), steps: [], edges: [] });

const dur = (s: number) => (s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);

/** One line about a step, for its node and the run view. */
export function stepSummary(s: Step, name: (id: string) => string, targetName: (type: string, id: string) => string = (_t, id) => id): string {
  switch (s.kind) {
    case "condition": return s.rules.map((r) => `${r.field} ${r.op}${r.value === undefined ? "" : ` ${JSON.stringify(r.value)}`}`).join(s.match === "any" ? " or " : " and ");
    case "ask": return `“${s.question}”${s.source ? ` on ${name(s.source)}` : ""}`;
    case "notify": return `${s.to.type === "channel" ? "Chat" : "Webhook"}: ${targetName(s.to.type, s.to.id) || "(choose one)"}`;
    case "speak": return `On ${name(s.source) || "(choose a camera)"}: “${s.text}”`;
    case "clip": return `${s.before_s ?? 5} s before to ${s.after_s ?? 10} s after`;
    case "story": return `${s.sources?.length ? s.sources.map(name).join(", ") : "The event's camera"}`;
    case "wait": return dur(s.seconds);
  }
}

export function triggerSummary(t: Trigger, name: (id: string) => string = (id) => id): string {
  if (t.type === "event") {
    const types = t.event_types?.length ? t.event_types.join(", ") : "any event";
    return `When ${types}${t.sources?.length ? ` on ${t.sources.map(name).join(", ")}` : ""}`;
  }
  if (t.type === "schedule") {
    const days = t.days?.length ? ` on ${t.days.join(", ")}` : "";
    return t.at ? `Every day at ${t.at}${days}` : `Every ${t.every_min ?? 60} min${days}`;
  }
  return "When its webhook is called";
}

/** Would an edge from → to close a loop (is `from` reachable from `to`)? */
export function wouldLoop(edges: Edge[], from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === from) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const e of edges) if (e.from === at) stack.push(e.to);
  }
  return false;
}

/** Adds an edge if the editor's rules allow it; otherwise says why. */
export function connect(def: Definition, from: string, to: string, branch?: "yes" | "no"): Definition | string {
  if (to === "trigger") return "Nothing leads into the trigger.";
  const kind = def.steps.find((s) => s.id === from)?.kind;
  if (from !== "trigger" && !kind) return "That step doesn't exist.";
  if (branch && !BRANCHING.has(kind ?? "")) return "Only condition and ask steps have yes and no.";
  if (!branch && kind && BRANCHING.has(kind)) branch = "yes";
  if (def.edges.some((e) => e.from === from && e.to === to && (e.branch ?? "") === (branch ?? ""))) return "Those steps are already joined.";
  if (wouldLoop(def.edges, from, to)) return "That would make a loop; a workflow runs each step at most once.";
  if (def.edges.length >= LIMITS.edges) return `A workflow has at most ${LIMITS.edges} connections.`;
  return { ...def, edges: [...def.edges, { from, to, ...(branch ? { branch } : {}) }] };
}

export function removeStep(def: Definition, id: string): Definition {
  return { ...def, steps: def.steps.filter((s) => s.id !== id), edges: def.edges.filter((e) => e.from !== id && e.to !== id) };
}

/** Steps the trigger can't reach: the API refuses them, so the editor points them out. */
export function unreachable(def: Definition): string[] {
  const reach = new Set(["trigger"]);
  const queue = ["trigger"];
  while (queue.length) {
    const at = queue.shift()!;
    for (const e of def.edges) if (e.from === at && !reach.has(e.to)) { reach.add(e.to); queue.push(e.to); }
  }
  return def.steps.filter((s) => !reach.has(s.id)).map((s) => s.id);
}

/** Where each node goes when it has no position yet: columns by depth from the trigger. */
export function layout(def: Definition): Record<string, Position> {
  const depth = new Map<string, number>([["trigger", 0]]);
  for (let pass = 0; pass < def.steps.length + 1; pass++) {
    for (const e of def.edges) {
      const d = depth.get(e.from);
      if (d !== undefined && (depth.get(e.to) ?? -1) < d + 1) depth.set(e.to, d + 1);
    }
  }
  const rows = new Map<number, number>();
  const out: Record<string, Position> = {};
  const place = (id: string, given?: Position) => {
    const d = depth.get(id) ?? Math.max(1, ...depth.values()) + 1;
    const r = rows.get(d) ?? 0;
    rows.set(d, r + 1);
    out[id] = given ?? { x: d * 280, y: r * 130 };
  };
  place("trigger", def.trigger.position);
  for (const s of def.steps) place(s.id, s.position);
  return out;
}

/** What a run's step statuses look like as words. */
export const statusWord: Record<string, string> = {
  queued: "Queued", running: "Running", waiting: "Waiting", succeeded: "Done", failed: "Failed", skipped: "Skipped", cancelled: "Cancelled",
};
