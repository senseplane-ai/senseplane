// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The activity query engine (ADR 0057) on hand-made intervals: the arithmetic,
// windows in a time zone, comparisons and coverage.
import { describe, expect, it } from "vitest";
import { type ActivityQuery, type Interval, type Loader, type What, answer, merge, resolveWindow } from "./activity-query.js";
import { dailyWindows, fromWall, localMidnight, shiftDays, wall } from "./local-time.js";

const TZ = "Europe/London";
// Wednesday 15 Oct 2026, 20:00 in London (BST, UTC+1).
const NOW = Date.parse("2026-10-14T19:00:00Z");
const at = (iso: string) => Date.parse(iso);
const min = 60_000;
let n = 0;
const iv = (source: string, start: string, minutes: number, extra: Partial<Interval> = {}): Interval => {
  const s = at(start);
  return { id: `act_${++n}`, source_id: source, zone: null, start: s, end: s + minutes * min, open: false, count: 1, ...extra };
};

/** A loader over fixed intervals per "what" key, recording everything as recorded unless told otherwise. */
function fake(data: Record<string, Interval[]>, gaps: Record<string, [number, number][]> = {}): Loader {
  const key = (w: What) => w.label ?? w.watch_id ?? w.sound ?? w.sensor?.sense ?? "";
  return {
    async intervals(w, ids, from, to) {
      return (data[key(w)] ?? []).filter((i) => ids.includes(i.source_id) && i.start < to && i.end >= from && (!w.zone || i.zone === w.zone));
    },
    async coverage(w, ids, from, to) {
      if (w.sensor) return null;
      const m = new Map<string, [number, number][]>();
      for (const id of ids) {
        const holes = (gaps[id] ?? []).sort((a, b) => a[0] - b[0]);
        const out: [number, number][] = [];
        let t = from;
        for (const [a, b] of holes) {
          if (a > t) out.push([t, Math.min(a, to)]);
          t = Math.max(t, b);
        }
        if (t < to) out.push([t, to]);
        m.set(id, out);
      }
      return m;
    },
  };
}
const SOURCES = [{ id: "src_kitchen", name: "Kitchen", site: "Mum's flat" }, { id: "src_bed", name: "Bedroom", site: "Mum's flat" }, { id: "src_shop", name: "Shop", site: "High St" }];
const ask = (q: Partial<ActivityQuery>, loader: Loader, now = NOW) => answer({ time_zone: TZ, ...q } as ActivityQuery, SOURCES, loader, now);

describe("local time", () => {
  it("finds local midnight and shifts days across daylight saving", () => {
    expect(new Date(localMidnight(NOW, TZ)).toISOString()).toBe("2026-10-13T23:00:00.000Z"); // 00:00 BST
    // Clocks go back on Sunday 25 Oct 2026: that day is 25 h long.
    const sat = fromWall(2026, 10, 24, 9, 0, TZ);
    expect(new Date(shiftDays(sat, 1, TZ)).toISOString()).toBe("2026-10-25T09:00:00.000Z"); // 09:00 GMT
    expect(wall(shiftDays(sat, 1, TZ), TZ)).toMatchObject({ d: 25, hh: 9, mm: 0, dow: 6 });
    expect(localMidnight(fromWall(2026, 10, 25, 12, 0, TZ), TZ, 1) - localMidnight(fromWall(2026, 10, 25, 12, 0, TZ), TZ)).toBe(25 * 3600_000);
  });

  it("cuts a range into nightly windows that run past midnight", () => {
    const w = dailyWindows(at("2026-10-12T23:00:00Z"), at("2026-10-14T23:00:00Z"), { from: "22:00", to: "06:00" }, TZ);
    expect(w.map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()])).toEqual([
      ["2026-10-12T23:00:00.000Z", "2026-10-13T05:00:00.000Z"], // the night into Tuesday, from the start of the range
      ["2026-10-13T21:00:00.000Z", "2026-10-14T05:00:00.000Z"],
      ["2026-10-14T21:00:00.000Z", "2026-10-14T23:00:00.000Z"],
    ]);
  });
});

describe("activity questions", () => {
  const meals = [
    iv("src_kitchen", "2026-10-14T07:10:00Z", 18),
    iv("src_kitchen", "2026-10-14T07:28:20Z", 4), // 20 s after the first: the same meal
    iv("src_kitchen", "2026-10-14T12:05:00Z", 31),
    iv("src_kitchen", "2026-10-14T16:00:00Z", 1), // a minute at the table: not a meal with min_duration_s
    iv("src_kitchen", "2026-10-13T18:00:00Z", 25), // yesterday
  ];

  it("counts today's meals, joining pieces a moment apart and skipping short ones", async () => {
    const a = await ask({ measure: "count", what: { watch_id: "wat_eat", min_duration_s: 300 } }, fake({ wat_eat: meals }));
    expect(a.value).toBe(2);
    expect(a.unit).toBe("count");
    expect(a.window).toEqual({ from: "2026-10-13T23:00:00.000Z", to: "2026-10-14T19:00:00.000Z", time_zone: TZ });
    expect(a.evidence.map((e) => [e.started_at, e.duration_s])).toEqual([["2026-10-14T07:10:00.000Z", 1340], ["2026-10-14T12:05:00.000Z", 1860]]);
    expect(a.coverage).toEqual({ recorded: 1, complete: true, gaps: [] });
  });

  it("adds up and finds the longest time, clipped to the window", async () => {
    const night = [iv("src_bed", "2026-10-13T21:30:00Z", 9 * 60)]; // 22:30 BST → 07:30 BST
    const total = await ask({ measure: "total_duration", what: { label: "person", zone: "bed" }, period: "today" }, fake({ person: night.map((i) => ({ ...i, zone: "bed" })) }));
    expect(total.value).toBe(7.5 * 3600); // only the part after midnight
    const nights = await ask({ measure: "total_duration", what: { label: "person", zone: "bed" }, period: "last_7_days", between: { from: "22:00", to: "07:00" } },
      fake({ person: night.map((i) => ({ ...i, zone: "bed" })) }));
    expect(nights.value).toBe(8.5 * 3600); // 22:30–07:00
    const longest = await ask({ measure: "longest", what: { watch_id: "wat_eat" } }, fake({ wat_eat: meals }));
    expect(longest.value).toBe(1860);
  });

  it("says how long since the last time, and the longest stretch without", async () => {
    const seen = [iv("src_kitchen", "2026-10-14T09:00:00Z", 30), iv("src_kitchen", "2026-10-14T15:00:00Z", 60)];
    const since = await ask({ measure: "since_last", what: { label: "person" } }, fake({ person: seen }));
    expect(since.value).toBe(3 * 3600); // last seen 16:00 UTC, now 19:00
    const going = await ask({ measure: "since_last", what: { label: "person" } }, fake({ person: [...seen, { ...iv("src_kitchen", "2026-10-14T18:30:00Z", 30), open: true }] }));
    expect(going.value).toBe(0);
    expect(going.notes).toContain("still going now");
    const gap = await ask({ measure: "longest_gap", what: { label: "person" } }, fake({ person: seen }));
    expect(gap.value).toBe(10 * 3600); // midnight BST (23:00 UTC) to 09:00 UTC
    // Last week, no window given: the last one is still found.
    const last = await ask({ measure: "last", what: { label: "person" } }, fake({ person: [iv("src_kitchen", "2026-10-09T10:00:00Z", 5)] }));
    expect(last.value).toBe("2026-10-09T10:00:00.000Z");
  });

  it("groups by hour, camera and site, with zeros for places with nothing", async () => {
    const people = [iv("src_shop", "2026-10-14T08:05:00Z", 2), iv("src_shop", "2026-10-14T08:40:00Z", 2), iv("src_kitchen", "2026-10-14T13:00:00Z", 2)];
    const byHour = await ask({ measure: "count", what: { label: "person" }, group_by: "hour" }, fake({ person: people }));
    expect(byHour.groups).toEqual([{ key: "09:00", value: 2 }, { key: "14:00", value: 1 }]);
    const bySource = await ask({ measure: "count", what: { label: "person" }, group_by: "source" }, fake({ person: people }));
    expect(bySource.groups).toEqual([{ key: "Bedroom", value: 0 }, { key: "Kitchen", value: 1 }, { key: "Shop", value: 2 }]);
    const site = await ask({ measure: "count", what: { label: "person" }, sites: ["High St"] }, fake({ person: people }));
    expect(site.value).toBe(2);
  });

  it("compares with the same weekday and the last 14 days, and sees a trend", async () => {
    // Meals by 20:00: 3 a day for two weeks, then fewer, then 1 today.
    const past: Interval[] = [];
    for (let d = 1; d <= 14; d++) {
      const day = shiftDays(at("2026-10-14T07:00:00Z"), -d, TZ);
      const k = d <= 4 ? 2 : 3;
      for (let j = 0; j < k; j++) past.push({ ...iv("src_kitchen", new Date(day + j * 5 * 3600_000).toISOString(), 20) });
    }
    const today = [iv("src_kitchen", "2026-10-14T07:00:00Z", 20)];
    const loader = fake({ wat_eat: [...past, ...today] });
    const a = await ask({ measure: "count", what: { watch_id: "wat_eat" }, compare: "last_14_days" }, loader);
    expect(a.value).toBe(1);
    expect(a.baseline).toMatchObject({ compare: "last_14_days", windows: 14 });
    expect(a.baseline!.mean).toBeCloseTo((4 * 2 + 10 * 3) / 14, 2);
    expect(a.baseline!.ratio).toBeLessThan(0.4);
    expect(a.trend?.direction).toBe("down");
    const wk = await ask({ measure: "count", what: { watch_id: "wat_eat" }, compare: "same_weekday" }, loader);
    // 4, 3, 2 and 1 weeks ago, oldest first; the data only goes back 14 days (and the camera recorded, so 0 is 0).
    expect(wk.baseline).toMatchObject({ windows: 4, values: [0, 0, 3, 3], mean: 1.5 });
  });

  it("skips past days the camera was mostly off when working out what is usual", async () => {
    const day = (d: number) => shiftDays(at("2026-10-14T08:00:00Z"), -d, TZ);
    const loader = fake({ person: [1, 2, 3].map((d) => iv("src_kitchen", new Date(day(d)).toISOString(), 30)) },
      { src_kitchen: [[localMidnight(day(2), TZ), localMidnight(day(2), TZ, 1)]] }); // off all day two days ago
    const a = await ask({ measure: "count", what: { label: "person" }, sources: ["src_kitchen"], compare: "last_14_days" }, loader);
    expect(a.baseline!.values.slice(-3)).toEqual([1, null, 1]);
  });

  it("finds one thing followed by another within a time", async () => {
    const breakfast = [iv("src_kitchen", "2026-10-14T07:00:00Z", 20), iv("src_kitchen", "2026-10-14T12:00:00Z", 30)];
    const pills = [iv("src_kitchen", "2026-10-14T07:30:00Z", 1), iv("src_kitchen", "2026-10-14T15:00:00Z", 1)];
    const a = await ask({ measure: "sequence", what: { watch_id: "wat_eat" }, then: { watch_id: "wat_pills" }, within_s: 3600 }, fake({ wat_eat: breakfast, wat_pills: pills }));
    expect(a.value).toBe(1); // after breakfast; the lunch one was 2.5 h later
    expect(a.evidence).toHaveLength(2);
  });

  it("reports coverage and doesn't claim absence it couldn't see", async () => {
    const loader = fake({ person: [] }, { src_kitchen: [[at("2026-10-14T06:00:00Z"), at("2026-10-14T15:00:00Z")]] });
    const a = await ask({ measure: "exists", what: { label: "person" }, sources: ["Kitchen"] }, loader);
    expect(a.value).toBe(false);
    expect(a.coverage.complete).toBe(false);
    expect(a.coverage.recorded).toBeCloseTo(11 / 20, 2);
    expect(a.coverage.gaps).toEqual([{ source_id: "src_kitchen", from: "2026-10-14T06:00:00.000Z", to: "2026-10-14T15:00:00.000Z" }]);
    expect(a.notes.join(" ")).toMatch(/recorded 55% .* isn't known/);
  });

  it("compares the time something first happened (she got up later than usual)", async () => {
    const ups = [0, 1, 2, 3].map((d) => iv("src_bed", new Date(shiftDays(at("2026-10-14T06:30:00Z"), -d, TZ) + (d === 0 ? 2 * 3600_000 : 0)).toISOString(), 5));
    const a = await ask({ measure: "first", what: { label: "person", zone: "door" }, compare: "last_14_days" }, fake({ person: ups.map((i) => ({ ...i, zone: "door" })) }));
    expect(a.value).toBe("2026-10-14T08:30:00.000Z");
    expect(a.baseline!.mean).toBe(7.5 * 3600); // 07:30 BST, as seconds after midnight
    expect(a.baseline!.delta).toBe(2 * 3600);
  });

  it("works on sensor readings: spans over a threshold and averages", async () => {
    const r = (t: string, v: number): Interval => ({ id: t, source_id: "src_bed", zone: null, start: at(t), end: at(t), open: false, count: 1, value: v });
    const temps = [r("2026-10-14T01:00:00Z", 15), r("2026-10-14T03:00:00Z", 19)];
    const avg = await ask({ measure: "average_value", what: { sensor: { sense: "temperature" } } }, fake({ temperature: temps }));
    expect(avg.value).toBe(17);
    expect(avg.coverage.recorded).toBeNull(); // not recorded video or audio
  });

  it("explains a malformed question", () => {
    expect(() => resolveWindow({ measure: "count", what: {} } as ActivityQuery, NOW)).toThrow(/exactly one of/);
    expect(() => resolveWindow({ measure: "sequence", what: { label: "person" } } as ActivityQuery, NOW)).toThrow(/then/);
    expect(() => resolveWindow({ measure: "count", what: { label: "person" }, time_zone: "Mars/Base" } as ActivityQuery, NOW)).toThrow(/time zone/);
    expect(() => resolveWindow({ measure: "count", what: { label: "person" }, from: "2026-01-01T00:00:00Z" } as ActivityQuery, NOW)).toThrow(/92 days/);
    expect(() => resolveWindow({ measure: "nope" as "count", what: { label: "person" } }, NOW)).toThrow(/measure/);
  });

  it("merges only the same place", () => {
    const m = merge([iv("a", "2026-10-14T07:00:00Z", 1), { ...iv("a", "2026-10-14T07:01:10Z", 1), zone: "door" }, iv("a", "2026-10-14T07:01:20Z", 1)]);
    expect(m.map((i) => [i.zone, i.end - i.start])).toEqual([[null, 140_000], ["door", 60_000]]);
  });
});
