// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Questions about activities (ADR 0057): one structured question, answered by
// arithmetic over intervals, never by a language model. The chat, MCP and REST
// all send this shape (spec/schemas/activity-query.json). `answer()` is pure:
// a Loader supplies intervals and recording coverage, already limited to what
// the caller may see.
import { dailyWindows, localMidnight, shiftDays, wall } from "./local-time.js";

export const MEASURES = ["exists", "count", "first", "last", "since_last", "total_duration", "longest", "average_duration", "longest_gap",
  "timeline", "sequence", "average_value", "min_value", "max_value"] as const;
export type Measure = (typeof MEASURES)[number];
export const PERIODS = ["today", "yesterday", "this_week", "last_hour", "last_24_hours", "last_7_days", "last_30_days"] as const;
export const GROUPS = ["hour", "day", "weekday", "source", "zone", "site"] as const;
export const COMPARES = ["previous_period", "same_weekday", "last_14_days", "last_28_days"] as const;

export interface What {
  label?: string; // presence: person, vehicle, animal or an everyday object
  watch_id?: string;
  sound?: string;
  sensor?: { sense: string; above?: number; below?: number };
  zone?: string;
  min_count?: number;
  min_duration_s?: number;
}

export interface ActivityQuery {
  measure: Measure;
  what: What;
  then?: What;
  within_s?: number;
  sources?: string[];
  sites?: string[];
  period?: (typeof PERIODS)[number];
  from?: string;
  to?: string;
  time_zone?: string;
  between?: { from: string; to: string };
  group_by?: (typeof GROUPS)[number];
  compare?: (typeof COMPARES)[number];
  limit?: number;
}

/** One activity, times in ms. `end` is now for one still going. */
export interface Interval {
  id: string;
  source_id: string;
  zone: string | null;
  start: number;
  end: number;
  open: boolean;
  count: number;
  summary?: string | null;
  value?: number; // sensors: the reading
}

export interface SourceInfo { id: string; name: string; site: string | null }

export interface Loader {
  intervals(what: What, sourceIds: string[], from: number, to: number): Promise<Interval[]>;
  /** Recorded ranges per source in [from, to); null when the thing isn't recorded video or audio (sensors). */
  coverage(what: What, sourceIds: string[], from: number, to: number): Promise<Map<string, [number, number][]> | null>;
}

export interface Answer {
  measure: Measure;
  value: number | boolean | string | null;
  unit: "boolean" | "count" | "seconds" | "time" | "value" | null;
  window: { from: string; to: string; time_zone: string };
  matched: number;
  groups?: { key: string; value: number | string | null }[];
  baseline?: { compare: string; windows: number; mean: number | null; ratio: number | null; delta: number | null; values: (number | null)[] };
  trend?: { per_day: number; direction: "up" | "down" | "flat" };
  coverage: { recorded: number | null; complete: boolean | null; gaps: { source_id: string; from: string; to: string }[] };
  evidence: { id: string; source_id: string; source_name: string; zone: string | null; started_at: string; ended_at: string | null; duration_s: number; summary?: string | null }[];
  notes: string[];
}

export class QueryError extends Error {}

const DAY = 86_400_000;
const MERGE_MS = 30_000; // the same thing a moment apart (a handover between brains, a brief miss) is one activity
const iso = (t: number) => new Date(t).toISOString();
const isTime = (m: Measure) => m === "first" || m === "last";

/** Validates a question and fills in its window; throws QueryError with a readable message. */
export function resolveWindow(q: ActivityQuery, now: number): { from: number; to: number; tz: string } {
  if (!(MEASURES as readonly string[]).includes(q.measure)) throw new QueryError(`measure must be one of ${MEASURES.join(", ")}`);
  const kinds = ["label", "watch_id", "sound", "sensor"].filter((k) => q.what?.[k as keyof What] !== undefined);
  if (kinds.length !== 1) throw new QueryError("what needs exactly one of label, watch_id, sound or sensor");
  if (q.measure === "sequence" && !q.then) throw new QueryError("a sequence needs `then`, the thing that follows");
  if (q.measure.endsWith("_value") && !q.what.sensor) throw new QueryError(`${q.measure} is for sensors`);
  const tz = q.time_zone || "UTC";
  try {
    wall(now, tz);
  } catch {
    throw new QueryError(`unknown time zone "${tz}"`);
  }
  if (q.between && !(/^\d\d:\d\d$/.test(q.between.from) && /^\d\d:\d\d$/.test(q.between.to))) throw new QueryError("between.from and between.to must be HH:MM");
  let from: number;
  let to = now;
  if (q.from || q.to) {
    from = q.from ? Date.parse(q.from) : now - DAY;
    to = q.to ? Date.parse(q.to) : now;
    if (Number.isNaN(from) || Number.isNaN(to)) throw new QueryError("from and to must be RFC 3339 times");
  } else {
    switch (q.period ?? "today") {
      case "today": from = localMidnight(now, tz); break;
      case "yesterday": from = localMidnight(now, tz, -1); to = localMidnight(now, tz); break;
      case "this_week": from = localMidnight(now, tz, -wall(now, tz).dow); break;
      case "last_hour": from = now - 3_600_000; break;
      case "last_24_hours": from = now - DAY; break;
      case "last_7_days": from = now - 7 * DAY; break;
      case "last_30_days": from = now - 30 * DAY; break;
      default: throw new QueryError(`period must be one of ${PERIODS.join(", ")}`);
    }
  }
  to = Math.min(to, now);
  if (to <= from) throw new QueryError("the window is empty (from must be before to, and not in the future)");
  if (to - from > 92 * DAY) throw new QueryError("the window can be at most 92 days");
  return { from, to, tz };
}

/** Joins activities of the same thing in the same place that are only a moment apart. */
export function merge(intervals: Interval[], gapMs = MERGE_MS): Interval[] {
  const by = new Map<string, Interval[]>();
  for (const i of intervals) {
    const k = `${i.source_id}\u0000${i.zone ?? ""}`;
    by.set(k, [...(by.get(k) ?? []), i]);
  }
  const out: Interval[] = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.start - b.start);
    let cur: Interval | undefined;
    for (const i of list) {
      if (cur && i.start - cur.end <= gapMs) {
        cur = { ...cur, end: Math.max(cur.end, i.end), open: cur.open || i.open, count: Math.max(cur.count, i.count), summary: cur.summary ?? i.summary };
        out[out.length - 1] = cur;
      } else {
        cur = { ...i };
        out.push(cur);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Clips intervals to the windows (a list of [from, to)), dropping what falls outside. */
function clip(intervals: Interval[], windows: [number, number][]): Interval[] {
  const out: Interval[] = [];
  for (const i of intervals) {
    for (const [a, b] of windows) {
      const s = Math.max(i.start, a);
      const e = Math.min(i.end, b);
      if (e > s || (i.start === i.end && i.start >= a && i.start < b)) out.push({ ...i, start: s, end: Math.max(e, s) });
    }
  }
  return out;
}

const dur = (i: Interval) => Math.max(0, i.end - i.start);
const secs = (ms: number) => Math.round(ms / 100) / 10;

/** Seconds after local midnight, for comparing first/last times across days. */
const timeOfDay = (t: number, tz: string) => {
  const w = wall(t, tz);
  return w.hh * 3600 + w.mm * 60 + w.ss;
};

function union(intervals: { start: number; end: number }[]): [number, number][] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: [number, number][] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last[1]) last[1] = Math.max(last[1], i.end);
    else out.push([i.start, i.end]);
  }
  return out;
}

function complement(cover: [number, number][], windows: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of windows) {
    let at = a;
    for (const [s, e] of cover) {
      if (e <= at || s >= b) continue;
      if (s > at) out.push([at, Math.min(s, b)]);
      at = Math.max(at, e);
      if (at >= b) break;
    }
    if (at < b) out.push([at, b]);
  }
  return out;
}

/** Pairs where `then` starts after `first` starts, and no later than within_s after `first` ends. */
function sequences(first: Interval[], then: Interval[], withinMs: number) {
  const pairs: [Interval, Interval][] = [];
  for (const a of first) {
    const b = then.find((x) => x.start >= a.start && x.start - a.end <= withinMs && x.source_id !== undefined);
    if (b) pairs.push([a, b]);
  }
  return pairs;
}

interface Measured { value: number | boolean | string | null; unit: Answer["unit"]; matched: Interval[] }

function measure(q: ActivityQuery, ivs: Interval[], windows: [number, number][], tz: string, then: Interval[] | undefined): Measured {
  const counted = ivs.filter((i) => windows.some(([a, b]) => i.start >= a && i.start < b)); // began in the window
  switch (q.measure) {
    case "exists": return { value: ivs.length > 0, unit: "boolean", matched: ivs };
    case "count": return { value: counted.length, unit: "count", matched: counted };
    case "first": {
      const f = counted[0];
      return { value: f ? iso(f.start) : null, unit: "time", matched: f ? [f] : [] };
    }
    case "last": {
      const l = [...ivs].sort((a, b) => b.start - a.start)[0];
      return { value: l ? iso(l.start) : null, unit: "time", matched: l ? [l] : [] };
    }
    case "since_last": {
      const end = windows[windows.length - 1]![1];
      const l = [...ivs].sort((a, b) => b.end - a.end)[0];
      if (!l) return { value: null, unit: "seconds", matched: [] };
      return { value: l.open ? 0 : secs(Math.max(0, end - l.end)), unit: "seconds", matched: [l] };
    }
    case "total_duration": return { value: secs(ivs.reduce((a, i) => a + dur(i), 0)), unit: "seconds", matched: ivs };
    case "longest": {
      const l = [...ivs].sort((a, b) => dur(b) - dur(a))[0];
      return { value: l ? secs(dur(l)) : 0, unit: "seconds", matched: l ? [l] : [] };
    }
    case "average_duration": return { value: ivs.length ? secs(ivs.reduce((a, i) => a + dur(i), 0) / ivs.length) : null, unit: "seconds", matched: ivs };
    case "longest_gap": {
      const gaps = complement(union(ivs), windows).map(([s, e]) => ({ s, e }));
      const g = gaps.sort((a, b) => b.e - b.s - (a.e - a.s))[0];
      return { value: g ? secs(g.e - g.s) : 0, unit: "seconds", matched: [] };
    }
    case "timeline": return { value: ivs.length, unit: "count", matched: ivs };
    case "sequence": {
      const pairs = sequences(counted, then ?? [], (q.within_s ?? 3600) * 1000);
      return { value: pairs.length, unit: "count", matched: pairs.flat() };
    }
    case "average_value":
    case "min_value":
    case "max_value": {
      const vals = ivs.map((i) => i.value).filter((v): v is number => typeof v === "number");
      if (!vals.length) return { value: null, unit: "value", matched: [] };
      const v = q.measure === "min_value" ? Math.min(...vals) : q.measure === "max_value" ? Math.max(...vals) : vals.reduce((a, b) => a + b, 0) / vals.length;
      return { value: Math.round(v * 100) / 100, unit: "value", matched: [] };
    }
  }
  return { value: null, unit: null, matched: [] };
}

/** A measured value as a number, for groups and baselines (times become seconds after local midnight). */
function numeric(m: Measured, q: ActivityQuery, tz: string): number | null {
  if (typeof m.value === "number") return m.value;
  if (typeof m.value === "boolean") return m.value ? 1 : 0;
  if (typeof m.value === "string" && isTime(q.measure)) return timeOfDay(Date.parse(m.value), tz);
  return null;
}

function bucketKey(group: string, i: Interval, tz: string, sites: Map<string, SourceInfo>): string {
  const w = wall(i.start, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (group) {
    case "hour": return `${pad(w.hh)}:00`;
    case "day": return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
    case "weekday": return ["mon", "tue", "wed", "thu", "fri", "sat", "sun"][w.dow]!;
    case "source": return sites.get(i.source_id)?.name ?? i.source_id;
    case "zone": return i.zone ?? "(anywhere)";
    case "site": return sites.get(i.source_id)?.site ?? "(no site)";
  }
  return "";
}

async function load(loader: Loader, what: What, sourceIds: string[], from: number, to: number): Promise<Interval[]> {
  let ivs = await loader.intervals(what, sourceIds, from, to);
  if (!what.sensor) ivs = merge(ivs, what.watch_id ? 60_000 : MERGE_MS);
  if (what.min_count) ivs = ivs.filter((i) => i.count >= what.min_count!);
  if (what.min_duration_s) ivs = ivs.filter((i) => dur(i) >= what.min_duration_s! * 1000);
  return ivs;
}

function windowsFor(q: ActivityQuery, from: number, to: number, tz: string): [number, number][] {
  return q.between ? dailyWindows(from, to, q.between, tz) : [[from, to]];
}

/** Answers one question. `sources` are the cameras and sensors in scope, already limited to what the caller may see. */
export async function answer(q: ActivityQuery, sources: SourceInfo[], loader: Loader, now = Date.now()): Promise<Answer> {
  const { from, to, tz } = resolveWindow(q, now);
  const notes: string[] = [];
  const info = new Map(sources.map((s) => [s.id, s]));
  const named = (s: SourceInfo) => !q.sources?.length || q.sources.some((n) => n === s.id || n.toLowerCase() === s.name.toLowerCase());
  const ids = sources.filter((s) => named(s) && (!q.sites?.length || (s.site && q.sites.includes(s.site)))).map((s) => s.id);
  if (!ids.length) notes.push("no camera or sensor in scope");
  const windows = windowsFor(q, from, to, tz);
  // since_last (and last, when no window was asked for) look back up to 30 days, so "when did she last…" has an
  // answer before today.
  const back = q.measure === "since_last" || (q.measure === "last" && !q.period && !q.from && !q.to);
  const lookFrom = back ? Math.min(from, to - 30 * DAY) : from;
  const wins = back ? windowsFor(q, lookFrom, to, tz) : windows;
  const ivs = clip(ids.length ? await load(loader, q.what, ids, lookFrom - DAY, to) : [], wins);
  const then = q.measure === "sequence" && q.then ? clip(await load(loader, q.then, ids, from - DAY, to + (q.within_s ?? 3600) * 1000), [[from, to + (q.within_s ?? 3600) * 1000]]) : undefined;
  const m = measure(q, ivs, wins, tz, then);

  const out: Answer = {
    measure: q.measure, value: m.value, unit: m.unit, window: { from: iso(from), to: iso(to), time_zone: tz }, matched: m.matched.length,
    coverage: { recorded: null, complete: null, gaps: [] }, evidence: [], notes,
  };

  if (q.group_by) {
    const buckets = new Map<string, Interval[]>();
    for (const i of ivs) buckets.set(bucketKey(q.group_by, i, tz, info), [...(buckets.get(bucketKey(q.group_by, i, tz, info)) ?? []), i]);
    if (q.group_by === "source" || q.group_by === "site" || q.group_by === "zone") {
      // Every camera (or site) in scope gets a row, so "which stores had nobody" shows the zeros.
      if (q.group_by !== "zone") for (const id of ids) {
        const k = q.group_by === "source" ? info.get(id)?.name ?? id : info.get(id)?.site ?? "(no site)";
        if (!buckets.has(k)) buckets.set(k, []);
      }
    }
    out.groups = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, list]) => {
      const g = measure(q, list, wins, tz, then);
      return { key, value: typeof g.value === "boolean" ? (g.value ? 1 : 0) : g.value };
    });
  }

  if (q.compare) {
    const shifts: [number, number][] = [];
    const len = to - from;
    if (q.compare === "previous_period") shifts.push([from - len, from]);
    else {
      const n = q.compare === "same_weekday" ? 4 : q.compare === "last_14_days" ? 14 : 28;
      const step = q.compare === "same_weekday" ? 7 : 1;
      for (let k = 1; k <= n; k++) shifts.push([shiftDays(from, -k * step, tz), shiftDays(to, -k * step, tz)]);
    }
    const allFrom = Math.min(...shifts.map((s) => s[0]));
    const past = await load(loader, q.what, ids, allFrom - DAY, from);
    const pastThen = q.measure === "sequence" && q.then ? await load(loader, q.then, ids, allFrom - DAY, from + (q.within_s ?? 3600) * 1000) : undefined;
    const pastCover = await loader.coverage(q.what, ids, allFrom, from);
    const values: (number | null)[] = [];
    for (const [a, b] of shifts) {
      const w = windowsFor(q, a, b, tz);
      const recorded = pastCover ? ratio(pastCover, ids, w) : 1;
      if (recorded < 0.5) {
        values.push(null); // the camera was mostly off then: that day says nothing about usual
        continue;
      }
      values.push(numeric(measure(q, clip(past, w), w, tz, pastThen ? clip(pastThen, [[a, b + (q.within_s ?? 3600) * 1000]]) : undefined), q, tz));
    }
    const known = values.filter((v): v is number => v !== null);
    const mean = known.length ? known.reduce((x, y) => x + y, 0) / known.length : null;
    const current = numeric(m, q, tz);
    out.baseline = {
      compare: q.compare, windows: known.length, mean: mean === null ? null : Math.round(mean * 100) / 100,
      ratio: mean && current !== null ? Math.round((current / mean) * 100) / 100 : null,
      delta: mean !== null && current !== null ? Math.round((current - mean) * 100) / 100 : null,
      values: values.reverse(), // oldest first
    };
    if (known.length >= 6) {
      // Least squares over the past windows, oldest first, then this one.
      const series = [...out.baseline.values, current].map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
      const n = series.length;
      const mx = series.reduce((a, p) => a + p[0], 0) / n;
      const my = series.reduce((a, p) => a + p[1], 0) / n;
      const sxx = series.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
      const slope = sxx ? series.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / sxx : 0;
      const perDay = q.compare === "same_weekday" ? slope / 7 : slope;
      const flat = Math.abs(slope) * n < 0.1 * Math.abs(my || 1);
      out.trend = { per_day: Math.round(perDay * 100) / 100, direction: flat ? "flat" : slope > 0 ? "up" : "down" };
    }
  }

  const cover = ids.length ? await loader.coverage(q.what, ids, from, to) : null;
  if (cover) {
    const r = ratio(cover, ids, windows);
    out.coverage.recorded = Math.round(r * 1000) / 1000;
    out.coverage.complete = r >= 0.98;
    const gaps: { source_id: string; s: number; e: number }[] = [];
    for (const id of ids) for (const [s, e] of complement(union((cover.get(id) ?? []).map(([a, b]) => ({ start: a, end: b }))), windows)) {
      if (e - s >= 60_000) gaps.push({ source_id: id, s, e });
    }
    out.coverage.gaps = gaps.sort((a, b) => b.e - b.s - (a.e - a.s)).slice(0, 10).map((g) => ({ source_id: g.source_id, from: iso(g.s), to: iso(g.e) }));
    if (!out.coverage.complete) {
      notes.push(`recorded ${Math.round(r * 100)}% of the time asked about: what happened in the gaps isn't known`);
    }
  }
  if (m.matched.some((i) => i.open)) notes.push("still going now");

  const limit = Math.min(Math.max(q.limit ?? 10, 1), q.measure === "timeline" ? 200 : 50);
  out.evidence = m.matched.slice(q.measure === "timeline" ? 0 : -limit).slice(0, limit).map((i) => ({
    id: i.id, source_id: i.source_id, source_name: info.get(i.source_id)?.name ?? i.source_id, zone: i.zone, started_at: iso(i.start),
    ended_at: i.open ? null : iso(i.end), duration_s: secs(dur(i)), ...(i.summary ? { summary: i.summary } : {}),
  }));
  return out;
}

/** Share of the windows (summed over the sources) that was recorded. */
function ratio(cover: Map<string, [number, number][]>, ids: string[], windows: [number, number][]): number {
  const total = windows.reduce((a, [s, e]) => a + (e - s), 0) * ids.length;
  if (!total) return 1;
  let rec = 0;
  for (const id of ids) {
    const u = union((cover.get(id) ?? []).map(([a, b]) => ({ start: a, end: b })));
    for (const [a, b] of windows) for (const [s, e] of u) rec += Math.max(0, Math.min(e, b) - Math.max(s, a));
  }
  return Math.min(1, rec / total);
}
