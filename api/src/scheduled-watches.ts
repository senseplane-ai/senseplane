// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Condition and digest watches (ADR 0057), checked here on a schedule rather
// than by the brain: a condition asks a question about activities and fires a
// watch.triggered event when its test starts to hold; a digest answers a few
// questions at a time of day and sends them as one event. Both go to the
// watch's destinations like any other watch.
import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";
import type { ActivityQuery, Answer } from "./activity-query.js";
import type { DataAccess } from "./data/access.js";
import type { WatchSchedule } from "./data/schema.js";
import { createEvent } from "./events.js";
import { fromWall, wall } from "./local-time.js";
import { ask } from "./routes/activity.js";
import { activeAt } from "./schedule.js";

type Test = { op: "lt" | "lte" | "gt" | "gte" | "eq" | "ne"; value: number; of?: "value" | "ratio" | "delta" };
export type ConditionTrigger = { type: "condition"; query: ActivityQuery; test: Test; at?: string; every_min?: number; days?: string[]; time_zone?: string };
export type DigestTrigger = { type: "digest"; at: string; days?: string[]; time_zone?: string; items: { label: string; query: ActivityQuery }[] };
type Trigger = ConditionTrigger | DigestTrigger;

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DEFAULT_EVERY_MIN = 10;
/** A daily check missed by more than this (the API was down) is skipped rather than sent late. */
const LATE_MS = 6 * 3600_000;
/** Below this share recorded, a condition can't tell, so it doesn't fire. */
const MIN_RECORDED = 0.5;

export function durationText(s: number): string {
  const n = Math.round(s);
  if (n < 60) return `${n} s`;
  const m = Math.floor(n / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.floor(h / 24)} days${h % 24 ? ` ${h % 24} h` : ""}`;
}

const clock = (t: number, tz: string) => {
  const w = wall(t, tz);
  return `${String(w.hh).padStart(2, "0")}:${String(w.mm).padStart(2, "0")}`;
};

/** An answer's value as words: "3 times", "1 h 25 min", "07:40", "none", "yes". */
export function valueText(a: Answer, tz: string): string {
  const v = a.value;
  if (v === null) return a.unit === "time" ? "not yet" : "none";
  if (a.unit === "boolean") return v ? "yes" : "no";
  if (a.unit === "time") return clock(Date.parse(String(v)), tz);
  if (a.unit === "seconds") return a.measure === "since_last" && v === 0 ? "going on now" : durationText(Number(v));
  if (a.unit === "count") return `${v} time${v === 1 ? "" : "s"}`;
  return String(v);
}

function usualText(a: Answer): string {
  const b = a.baseline;
  if (!b || b.mean === null) return "";
  const mean = a.unit === "seconds" ? durationText(b.mean) : a.unit === "time" ? `${String(Math.floor(b.mean / 3600)).padStart(2, "0")}:${String(Math.floor((b.mean % 3600) / 60)).padStart(2, "0")}` : String(Math.round(b.mean * 10) / 10);
  return ` (usually ${mean}${a.trend && a.trend.direction !== "flat" ? `, trending ${a.trend.direction}` : ""})`;
}

const secondsOfDay = (t: number, tz: string) => {
  const w = wall(t, tz);
  return w.hh * 3600 + w.mm * 60 + w.ss;
};

/** Whether the test holds. Times (first, last) are compared as seconds after local midnight. */
export function holds(t: Test, a: Answer, tz: string, now: number): boolean | undefined {
  const of = t.of ?? "value";
  const raw = of === "ratio" ? a.baseline?.ratio : of === "delta" ? a.baseline?.delta : a.value;
  if (raw === null || raw === undefined) {
    // Nothing to measure: a count of nothing is 0; a first time that hasn't come yet is "not before now".
    if (of === "value" && (a.unit === "count" || a.unit === "boolean")) return holds(t, { ...a, value: 0 }, tz, now);
    if (of === "value" && a.unit === "time") return holds(t, { ...a, value: new Date(now).toISOString() }, tz, now);
    return undefined;
  }
  const v = typeof raw === "boolean" ? (raw ? 1 : 0) : typeof raw === "string" ? secondsOfDay(Date.parse(raw), tz) : raw;
  switch (t.op) {
    case "lt": return v < t.value;
    case "lte": return v <= t.value;
    case "gt": return v > t.value;
    case "gte": return v >= t.value;
    case "eq": return v === t.value;
    case "ne": return v !== t.value;
  }
}

/** When this watch is next due relative to its last check; undefined when it isn't due now. */
export function due(trig: Trigger, tz: string, last: number | null, now: number): number | undefined {
  const w = wall(now, tz);
  if (trig.days?.length && !trig.days.includes(DAYS[w.dow]!)) return undefined;
  if (trig.at) {
    const [hh, mm] = trig.at.split(":").map(Number) as [number, number];
    const at = fromWall(w.y, w.m, w.d, hh, mm, tz);
    if (now < at || now - at > LATE_MS || (last !== null && last >= at)) return undefined;
    return at;
  }
  const every = ((trig as ConditionTrigger).every_min ?? DEFAULT_EVERY_MIN) * 60_000;
  return last === null || now - last >= every - 1000 ? now : undefined;
}

/** Checks every condition and digest watch that is due. Returns how many fired. */
export async function runScheduledWatches(data: DataAccess, log?: FastifyBaseLogger, now = Date.now()): Promise<number> {
  const { rows } = await sql<{ account_id: string; id: string }>`SELECT * FROM scheduled_watches()`.execute(data.db());
  let fired = 0;
  for (const r of rows) {
    try {
      if (await checkOne(data, r.account_id, r.id, now)) fired++;
    } catch (err) {
      log?.warn({ err, watch: r.id }, "scheduled watch check failed");
    }
  }
  return fired;
}

async function checkOne(data: DataAccess, accountId: string, watchId: string, now: number): Promise<boolean> {
  const w = await data.withAccount(accountId, (s) => s.db.selectFrom("watches").selectAll().where("id", "=", watchId).executeTakeFirst());
  if (!w || w.status !== "active") return false;
  const trig = (w.compiled as unknown as { trigger: Trigger }).trigger;
  const schedule = w.active_hours as WatchSchedule | null;
  const tz = trig.time_zone || schedule?.time_zone || (await data.withAccount(accountId, (s) => s.account.get()))?.time_zone || "UTC";
  const last = w.last_checked_at ? new Date(w.last_checked_at).getTime() : null;
  const slot = due(trig, tz, last, now);
  if (slot === undefined || !activeAt(new Date(now), schedule)) return false;
  const query = (q: ActivityQuery): ActivityQuery => ({ ...q, sources: q.sources?.length ? q.sources : w.sources, time_zone: q.time_zone || tz });
  const fire = async (key: string, summary: string) =>
    data.withAccount(accountId, (s) => createEvent(s, {
      event_key: key, source_id: w.sources[0]!, type: "watch.triggered", sense: "video", occurred_at: new Date(now), summary,
      labels: [], zones: [], confidence: null, verified: null, watch_id: w.id,
    }));
  const done = (condition: boolean | null) =>
    data.withAccount(accountId, (s) => s.db.updateTable("watches").set({ last_checked_at: new Date(now), last_condition: condition }).where("id", "=", w.id).execute());

  if (trig.type === "digest") {
    const lines: string[] = [];
    for (const item of trig.items) {
      const a = await ask(data, accountId, undefined, query(item.query), now).catch(() => undefined);
      lines.push(`${item.label}: ${a ? `${valueText(a, tz)}${usualText(a)}${a.coverage.complete === false ? " (part of the day not recorded)" : ""}` : "couldn't be worked out"}`);
    }
    await done(null);
    await fire(`dig:${w.id}:${new Date(slot).toISOString().slice(0, 16)}`, `${w.instruction}\n${lines.join("\n")}`);
    return true;
  }

  const a = await ask(data, accountId, undefined, query(trig.query), now);
  const recorded = a.coverage.recorded;
  const result = recorded !== null && recorded < MIN_RECORDED ? undefined : holds(trig.test, a, tz, now);
  // A condition fires when it starts to hold; a daily check fires every day it holds.
  const start = result === true && (trig.at ? true : w.last_condition !== true);
  await done(result ?? null);
  if (!start) return false;
  const gaps = a.coverage.complete === false ? ` Only ${Math.round((recorded ?? 0) * 100)}% of that time was recorded.` : "";
  const ev = await fire(`cond:${w.id}:${new Date(slot).toISOString().slice(0, 16)}`, `${w.instruction}: ${valueText(a, tz)}${usualText(a)}.${gaps}`);
  return !!ev;
}
