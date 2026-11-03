// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Starting workflow runs (ADR 0072): from an event (in the event's own
// transaction), a schedule, a signed webhook or a person. Each start is
// counted under a lock on the workflow's row, so concurrent triggers can't
// all slip under the run rate; one over it is dropped and counted on the
// workflow. Kept apart from the engine so events.ts stays light.
import { type Selectable, sql } from "kysely";
import type { AccountScope } from "./data/access.js";
import { newId } from "./data/ids.js";
import type { EventsTable, WorkflowRunsTable, WorkflowsTable } from "./data/schema.js";
import { LIMITS, type WorkflowDefinition, type WorkflowRunTrigger } from "./workflow-spec.js";

export type WorkflowRow = Selectable<WorkflowsTable>;
export type WorkflowRunRow = Selectable<WorkflowRunsTable>;

/** Wakes this process's workflow worker when it queued a run. */
export const workflowKick = new EventTarget();

/** An event type pattern: the type, "*", or a prefix wildcard such as "detection.*". */
const typeMatches = (pattern: string, type: string) => pattern === "*" || pattern === type || (pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1)));

/** Does this event start this workflow? Only events on its own sources ever do. */
export function eventStarts(w: Pick<WorkflowRow, "source_ids" | "definition">, ev: Pick<Selectable<EventsTable>, "source_id" | "type" | "watch_id">): boolean {
  const t = w.definition.trigger;
  if (t.type !== "event" || !w.source_ids.includes(ev.source_id)) return false;
  if (t.sources?.length && !t.sources.includes(ev.source_id)) return false;
  if (t.watch_id && ev.watch_id !== t.watch_id) return false;
  return !t.event_types?.length || t.event_types.some((p) => typeMatches(p, ev.type));
}

export type StartOutcome = { run: WorkflowRunRow } | { dropped: "workflow" | "account" | "disabled" };

/**
 * Queues a run of a workflow, within its run rate. `s` is the caller's transaction. Times are the database's
 * (ADR 0058), so a process whose clock is ahead can't queue a run the claim doesn't see as due yet.
 */
export async function startRun(s: AccountScope, workflowId: string, trigger: WorkflowRunTrigger, eventId: string | null = null): Promise<StartOutcome> {
  const w = await s.db.selectFrom("workflows").selectAll().where("id", "=", workflowId).forUpdate().executeTakeFirst();
  if (!w || (!w.enabled && trigger.type !== "manual")) return { dropped: "disabled" };
  const since = (ms: number) => sql<Date>`now() - make_interval(secs => ${ms / 1000})`;
  const counts = await s.db.selectFrom("workflow_runs")
    .select((eb) => [
      eb.fn.countAll<string>().filterWhere("created_at", ">", since(60_000)).filterWhere("workflow_id", "=", workflowId).as("minute"),
      eb.fn.countAll<string>().filterWhere("workflow_id", "=", workflowId).as("hour"),
      eb.fn.countAll<string>().as("account"),
    ])
    .where("created_at", ">", since(3600_000))
    .executeTakeFirstOrThrow();
  const over = Number(counts.minute) >= LIMITS.perMinute || Number(counts.hour) >= LIMITS.perHour ? "workflow" as const
    : Number(counts.account) >= LIMITS.accountPerHour ? "account" as const : undefined;
  if (over) {
    await s.db.updateTable("workflows").set((eb) => ({ runs_dropped: eb("runs_dropped", "+", 1) })).where("id", "=", workflowId).execute();
    return { dropped: over };
  }
  const run = await s.db.insertInto("workflow_runs").values({
    id: newId("wfr"), account_id: s.accountId, workflow_id: w.id, definition: JSON.stringify(w.definition), source_ids: w.source_ids,
    workflow_name: w.name, trigger: JSON.stringify(trigger), event_id: eventId, status: "queued", due_at: sql`now()`, created_at: sql`now()`,
  }).returningAll().executeTakeFirstOrThrow();
  await s.db.updateTable("workflows").set({ last_run_at: sql`now()` }).where("id", "=", w.id).execute();
  // Wake the worker just after this transaction commits.
  setTimeout(() => workflowKick.dispatchEvent(new Event("kick")), 20);
  return { run };
}

/** An event was stored: every enabled workflow it starts gets a run (createEvent, in the event's transaction). */
export async function queueWorkflowsForEvent(s: AccountScope, ev: Selectable<EventsTable>): Promise<number> {
  const candidates = await s.db.selectFrom("workflows").select(["id", "source_ids", "definition"])
    .where("trigger_type", "=", "event").where("enabled", "=", true)
    .where((eb) => eb(eb.val(ev.source_id), "=", eb.fn.any("source_ids")))
    .execute();
  let n = 0;
  for (const w of candidates) {
    if (!eventStarts(w as { source_ids: string[]; definition: WorkflowDefinition }, ev)) continue;
    const out = await startRun(s, w.id, { type: "event", event_id: ev.id, event_type: ev.type }, ev.id);
    if ("run" in out) n++;
  }
  return n;
}

