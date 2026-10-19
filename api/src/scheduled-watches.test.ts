// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Condition and digest watches (ADR 0057): checked on a schedule against
// activities in Postgres, firing watch.triggered events.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Answer } from "./activity-query.js";
import { storeActivity } from "./brain-events.js";
import { createApi, type SenseplaneApi } from "./index.js";
import { handleMediaEvent } from "./indexer.js";
import { fromWall } from "./local-time.js";
import { due, holds, runScheduledWatches, valueText } from "./scheduled-watches.js";
import { createTestDatabase } from "./testdb.js";

const log = { warn() {}, error() {}, info() {} } as never;
const TZ = "Europe/London";
const iso = (t: number) => new Date(t).toISOString();
// A day in London: Thursday 15 Oct 2026.
const at = (hh: number, mm = 0, d = 15) => fromWall(2026, 10, d, hh, mm, TZ);

describe("when a scheduled watch is due", () => {
  it("runs a daily check once, after its time, and skips it when far too late", () => {
    const trig = { type: "condition" as const, query: { measure: "count" as const, what: { label: "person" } }, test: { op: "eq" as const, value: 0 }, at: "10:00" };
    expect(due(trig, TZ, null, at(9, 59))).toBeUndefined();
    expect(due(trig, TZ, null, at(10, 0))).toBe(at(10));
    expect(due(trig, TZ, at(10, 0), at(10, 30))).toBeUndefined(); // already done today
    expect(due(trig, TZ, at(10, 0, 14), at(10, 30))).toBe(at(10)); // yesterday's doesn't count
    expect(due(trig, TZ, null, at(17, 0))).toBeUndefined(); // the API was down past the time by more than 6 h
    expect(due({ ...trig, days: ["mon"] }, TZ, null, at(10, 0))).toBeUndefined(); // the 15th is a Thursday
    const every = { ...trig, at: undefined, every_min: 15 };
    expect(due(every, TZ, at(9, 0), at(9, 10))).toBeUndefined();
    expect(due(every, TZ, at(9, 0), at(9, 15))).toBe(at(9, 15));
  });

  it("tests values, ratios and times of day", () => {
    const a = (value: Answer["value"], unit: Answer["unit"], extra: Partial<Answer> = {}) =>
      ({ measure: "count", value, unit, window: { from: "", to: "", time_zone: TZ }, matched: 0, coverage: { recorded: 1, complete: true, gaps: [] }, evidence: [], notes: [], ...extra }) as Answer;
    expect(holds({ op: "eq", value: 0 }, a(null, "count"), TZ, at(10))).toBe(true); // nothing counted is 0
    expect(holds({ op: "lt", value: 0.7, of: "ratio" }, a(1, "count", { baseline: { compare: "last_14_days", windows: 14, mean: 3, ratio: 0.33, delta: -2, values: [] } }), TZ, at(20))).toBe(true);
    expect(holds({ op: "lt", value: 0.7, of: "ratio" }, a(1, "count"), TZ, at(20))).toBeUndefined(); // no baseline to compare with
    // "Not up by 09:00": the first time hasn't come yet at 09:30, so it is later than 09:00.
    expect(holds({ op: "gt", value: 9 * 3600 }, { ...a(null, "time"), measure: "first" }, TZ, at(9, 30))).toBe(true);
    expect(holds({ op: "gt", value: 9 * 3600 }, { ...a(iso(at(7, 40)), "time"), measure: "first" }, TZ, at(9, 30))).toBe(false);
    expect(valueText({ ...a(iso(at(7, 40)), "time"), measure: "first" }, TZ)).toBe("07:40");
    expect(valueText(a(11400, "seconds"), TZ)).toBe("3 h 10 min");
    expect(valueText(a(1, "count"), TZ)).toBe("1 time");
  });
});

describe("scheduled watches", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let kitchen: string;
  let n = 0;
  const watch = async (instruction: string, trigger: Record<string, unknown>) => {
    const id = `wat_sched${++n}`;
    await api.data.withAccount(acc, (s) => s.db.insertInto("watches").values({
      id, account_id: acc, instruction, sources: [kitchen], mode: "alert", compiled: JSON.stringify({ trigger, cooldown_s: 0, active_hours: null }),
      estimate: JSON.stringify({}), status: "active", warnings: [], compiler: "user",
    } as never).execute());
    return id;
  };
  const events = (id: string) => api.data.withAccount(acc, (s) => s.db.selectFrom("events").select(["summary", "occurred_at", "type"]).where("watch_id", "=", id).orderBy("occurred_at").execute());
  const presence = (key: string, from: number, to: number, zone: string | null = "kitchen") =>
    storeActivity(api.data, acc, kitchen, { activity_key: key, kind: "presence", label: "person", zone, started_at: iso(from), last_seen_at: iso(to), ended_at: iso(to), peak_count: 1 }, log);

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } } });
    acc = (await api.data.accounts.create("Scheduled")).id;
    await api.data.withAccount(acc, (s) => s.db.updateTable("accounts").set({ time_zone: TZ }).execute());
    const key = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    kitchen = (await api.public.inject({ method: "POST", url: "/v1/sources", payload: { name: "Kitchen", type: "browser" }, headers: { authorization: `Bearer ${key}` } })).json().id;
    // Recorded all of the 14th and the 15th until 21:00, except 12:00–19:00 on the 15th.
    for (let t = at(0, 0, 14); t < at(21); t += 10 * 60_000) {
      if (t >= at(12) && t < at(19)) continue;
      await handleMediaEvent(api.data, "media.segment.written", { account_id: acc, source_id: kitchen, key: `raw/${t}.m4s`, init_key: "raw/init.mp4",
        start: iso(t), duration_ms: 10 * 60_000, bytes: 1, codec: "h264" }, log);
    }
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("alerts at 10:00 when nobody has been in the kitchen this morning, once a day", async () => {
    const id = await watch("Nobody in the kitchen by 10", { type: "condition", query: { measure: "count", what: { label: "person", zone: "kitchen" } }, test: { op: "eq", value: 0 }, at: "10:00" });
    await presence("p-14", at(8, 0, 14), at(8, 20, 14)); // yesterday someone was
    await runScheduledWatches(api.data, log, at(9, 0));
    expect(await events(id)).toHaveLength(0); // not 10 yet
    expect(await runScheduledWatches(api.data, log, at(10, 1))).toBe(1);
    expect((await events(id))[0]!.summary).toBe("Nobody in the kitchen by 10: 0 times.");
    await runScheduledWatches(api.data, log, at(10, 30));
    expect(await events(id)).toHaveLength(1); // once a day
    await api.data.withAccount(acc, (s) => s.db.updateTable("watches").set({ status: "paused" }).where("id", "=", id).execute());
  });

  it("alerts once when there has been no movement for 3 hours, and again only after it stopped holding", async () => {
    const id = await watch("No one seen in the kitchen for 3 hours", { type: "condition", query: { measure: "since_last", what: { label: "person", zone: "kitchen" } },
      test: { op: "gte", value: 3 * 3600 }, every_min: 10 });
    await presence("p-15a", at(6, 0), at(7, 0));
    await runScheduledWatches(api.data, log, at(9, 0)); // 2 h since: not yet
    expect(await events(id)).toHaveLength(0);
    await runScheduledWatches(api.data, log, at(10, 5)); // 3 h 5 min since
    const [e] = await events(id);
    expect(e!.summary).toBe("No one seen in the kitchen for 3 hours: 3 h 5 min.");
    await runScheduledWatches(api.data, log, at(10, 20)); // still holds: no repeat
    expect(await events(id)).toHaveLength(1);
    await presence("p-15b", at(10, 25), at(10, 40)); // someone came in
    await runScheduledWatches(api.data, log, at(10, 45));
    await runScheduledWatches(api.data, log, at(11, 0));
    expect(await events(id)).toHaveLength(1);
    await api.data.withAccount(acc, (s) => s.db.updateTable("watches").set({ status: "paused" }).where("id", "=", id).execute());
  });

  it("doesn't alert about absence when the camera mostly wasn't recording", async () => {
    // 12:00–19:00 wasn't recorded: "nobody between 12 and 19" can't be told.
    const id = await watch("Nobody in the kitchen in the afternoon", { type: "condition", query: { measure: "count", what: { label: "person", zone: "kitchen" }, between: { from: "12:00", to: "19:00" } },
      test: { op: "eq", value: 0 }, at: "19:30" });
    expect(await runScheduledWatches(api.data, log, at(19, 31))).toBe(0);
    expect(await events(id)).toHaveLength(0);
    const w = await api.data.withAccount(acc, (s) => s.db.selectFrom("watches").select(["last_checked_at", "last_condition"]).where("id", "=", id).executeTakeFirstOrThrow());
    expect(w.last_checked_at).not.toBeNull();
    expect(w.last_condition).toBeNull(); // couldn't tell
  });

  it("sends a digest of the day at 20:00", async () => {
    const id = await watch("Mum's day", { type: "digest", at: "20:00", items: [
      { label: "First seen in the kitchen", query: { measure: "first", what: { label: "person", zone: "kitchen" } } },
      { label: "Time in the kitchen", query: { measure: "total_duration", what: { label: "person", zone: "kitchen" } } },
      { label: "Visits to the kitchen", query: { measure: "count", what: { label: "person", zone: "kitchen" } } },
    ] });
    await runScheduledWatches(api.data, log, at(20, 2));
    const [e] = await events(id);
    expect(e!.summary).toBe([
      "Mum's day",
      "First seen in the kitchen: 06:00 (part of the day not recorded)",
      "Time in the kitchen: 1 h 15 min (part of the day not recorded)",
      "Visits to the kitchen: 2 times (part of the day not recorded)",
    ].join("\n"));
    expect(e!.type).toBe("watch.triggered");
  });
});
