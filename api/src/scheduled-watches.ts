// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Condition and digest watches (ADR 0057), checked here on a schedule rather
// than by the brain (each due watch claimed by one API process, ADR 0058): a condition asks a question about activities and fires a
// watch.triggered event when its test starts to hold; a digest answers a few
// questions at a time of day and sends them as one event. Both go to the
// watch's destinations like any other watch.
import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";
import type { ActivityQuery, Answer } from "./activity-query.js";
import type { DataAccess } from "./data/access.js";
import type { WatchSchedule } from "./data/schema.js";
import { createEvent } from "./events.js";
import { startClaimLoop } from "./jobs.js";
import { fromWall, localMidnight, wall } from "./local-time.js";
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

const DAY_MS = 86400_000;
/** A checker's lease on a watch: another process takes it over after this (ADR 0058). */
const LEASE_S = 120;
/** After a check that failed (an error, not a result), when to try again. */
const RETRY_MS = 5 * 60_000;

/** Whether the watch's days and hours allow a check at `t`. */
function allowedAt(t: number, tz: string, days: string[] | undefined, schedule: WatchSchedule | null): boolean {
  if (days?.length && !days.includes(DAYS[wall(t, tz).dow]!)) return false;
  return activeAt(new Date(t), schedule);
}

/** The first minute at or after `t` that the watch's days and hours allow (within 8 days). */
function nextAllowed(t: number, tz: string, days: string[] | undefined, schedule: WatchSchedule | null): number {
  if (allowedAt(t, tz, days, schedule)) return t;
  const step = 5 * 60_000;
  for (let u = t + step; u < t + 8 * DAY_MS; u += step) {
    if (!allowedAt(u, tz, days, schedule)) continue;
    // Back to the first allowed minute in this step.
    let v = u;
    while (v - 60_000 > t && allowedAt(v - 60_000, tz, days, schedule)) v -= 60_000;
    return v;
  }
  return t + DAY_MS;
}

/**
 * When to check next, after a check at `now` (`ran`) or a claim that found it not due. A daily check is next
 * due at its time on the next allowed day; a repeating one an interval after it last ran, when its hours allow.
 */
export function nextCheck(trig: Trigger, tz: string, schedule: WatchSchedule | null, last: number | null, now: number, ran: boolean): number {
  if (trig.at) {
    const [hh, mm] = trig.at.split(":").map(Number) as [number, number];
    for (let d = 0; d <= 8; d++) {
      const w = wall(localMidnight(now, tz, d), tz);
      if (trig.days?.length && !trig.days.includes(DAYS[w.dow]!)) continue;
      const t = fromWall(w.y, w.m, w.d, hh, mm, tz);
      if (t > now) return t;
    }
    return now + DAY_MS;
  }
  const every = ((trig as ConditionTrigger).every_min ?? DEFAULT_EVERY_MIN) * 60_000;
  const after = ran || last === null ? now + every : Math.max(now + 1000, last + every);
  return nextAllowed(after, tz, trig.days, schedule);
}

type Claimed = { account_id: string; id: string };

/** Claims up to `max` due condition and digest watches for this process. */
async function claimDue(data: DataAccess, max: number, now?: number): Promise<Claimed[]> {
  const at = now === undefined ? sql`now()` : new Date(now);
  return (await sql<Claimed>`select * from claim_scheduled_watches(${max}, ${LEASE_S}, ${at})`.execute(data.db())).rows;
}

/** Checks one claimed watch; a check that errors is tried again later. Returns whether it fired. */
async function checkClaimed(data: DataAccess, r: Claimed, now: number, log?: FastifyBaseLogger): Promise<boolean> {
  try {
    return await checkOne(data, r.account_id, r.id, now);
  } catch (err) {
    log?.warn({ err, watch: r.id }, "scheduled watch check failed");
    await data.withAccount(r.account_id, (s) => s.db.updateTable("watches")
      .set({ next_check_at: new Date(now + RETRY_MS), claimed_until: null }).where("id", "=", r.id).execute()).catch(() => undefined);
    return false;
  }
}

/** Claims the condition and digest watches that are due and checks them. Returns how many fired. `now` stands in for the clock in tests. */
export async function runScheduledWatches(data: DataAccess, log?: FastifyBaseLogger, now?: number, max = 50): Promise<number> {
  let fired = 0;
  for (const r of await claimDue(data, max, now)) if (await checkClaimed(data, r, now ?? Date.now(), log)) fired++;
  return fired;
}

/** Checks due scheduled watches every few seconds, in whichever process claims each (ADR 0058). */
export function startScheduledWatches(data: DataAccess, log: FastifyBaseLogger, intervalMs = 5000) {
  return startClaimLoop({
    name: "scheduled-watches", intervalMs, log, batch: 50,
    claim: (max) => claimDue(data, max),
    handle: async (r) => void (await checkClaimed(data, r, Date.now(), log)),
  });
}

async function checkOne(data: DataAccess, accountId: string, watchId: string, now: number): Promise<boolean> {
  const w = await data.withAccount(accountId, (s) => s.db.selectFrom("watches").selectAll().where("id", "=", watchId).executeTakeFirst());
  if (!w) return false;
  const trig = (w.compiled as unknown as { trigger: Trigger }).trigger;
  const schedule = w.active_hours as WatchSchedule | null;
  const tz = trig.time_zone || schedule?.time_zone || (await data.withAccount(accountId, (s) => s.account.get()))?.time_zone || "UTC";
  const last = w.last_checked_at ? new Date(w.last_checked_at).getTime() : null;
  const slot = due(trig, tz, last, now);
  if (w.status !== "active" || slot === undefined || !activeAt(new Date(now), schedule)) {
    await data.withAccount(accountId, (s) => s.db.updateTable("watches")
      .set({ next_check_at: w.status === "active" ? new Date(nextCheck(trig, tz, schedule, last, now, false)) : null, claimed_until: null })
      .where("id", "=", w.id).execute());
    return false;
  }
  const query = (q: ActivityQuery): ActivityQuery => ({ ...q, sources: q.sources?.length ? q.sources : w.sources, time_zone: q.time_zone || tz });
  const fire = async (key: string, summary: string) =>
    data.withAccount(accountId, (s) => createEvent(s, {
      event_key: key, source_id: w.sources[0]!, type: "watch.triggered", sense: "video", occurred_at: new Date(now), summary,
      labels: [], zones: [], confidence: null, verified: null, watch_id: w.id,
    }));
  const done = (condition: boolean | null) =>
    data.withAccount(accountId, (s) => s.db.updateTable("watches").set({
      last_checked_at: new Date(now), last_condition: condition, next_check_at: new Date(nextCheck(trig, tz, schedule, now, now, true)), claimed_until: null,
    }).where("id", "=", w.id).execute());

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
