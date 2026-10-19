// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Background work shared by several API processes (ADR 0058): jobs run once
// per interval whichever process claims them, a crashed process's claim is
// taken over after its lease, and scheduled watches and webhook deliveries are
// each handled by one process.
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvent } from "./events.js";
import { createApi, type SenseplaneApi } from "./index.js";
import { handleMediaEvent } from "./indexer.js";
import { type Job, runDueJobs } from "./jobs.js";
import { fromWall } from "./local-time.js";
import { nextCheck, runScheduledWatches } from "./scheduled-watches.js";
import { createTestDatabase } from "./testdb.js";

const log = { warn() {}, error() {}, info() {} } as never;
const TZ = "Europe/London";
const at = (hh: number, mm = 0, d = 15, m = 10) => fromWall(2026, m, d, hh, mm, TZ);
const iso = (t: number) => new Date(t).toISOString();

describe("when a scheduled watch is next checked", () => {
  const daily = { type: "condition" as const, query: { measure: "count" as const, what: { label: "person" } }, test: { op: "eq" as const, value: 0 }, at: "10:00" };
  it("puts a daily check at its time on the next allowed day", () => {
    expect(iso(nextCheck(daily, TZ, null, null, at(9, 0), false))).toBe(iso(at(10))); // later today
    expect(iso(nextCheck(daily, TZ, null, at(10), at(10, 0), true))).toBe(iso(at(10, 0, 16))); // tomorrow
    // Thursday the 15th, weekdays only: Friday, then Monday.
    const weekdays = { ...daily, days: ["mon", "tue", "wed", "thu", "fri"] };
    expect(iso(nextCheck(weekdays, TZ, null, null, at(11, 0, 16), true))).toBe(iso(at(10, 0, 19)));
    // Across the clocks going back (Sunday the 25th): still 10:00 local.
    expect(iso(nextCheck(daily, TZ, null, null, at(11, 0, 24), true))).toBe("2026-10-25T10:00:00.000Z");
  });
  it("puts a repeating check an interval on, inside its hours", () => {
    const every = { ...daily, at: undefined, every_min: 10 };
    expect(iso(nextCheck(every, TZ, null, null, at(9, 0), true))).toBe(iso(at(9, 10)));
    expect(iso(nextCheck(every, TZ, null, at(9, 0), at(9, 3), false))).toBe(iso(at(9, 10))); // claimed early: from the last check
    const day = { from: "08:00", to: "22:00", time_zone: TZ };
    expect(iso(nextCheck(every, TZ, day, null, at(21, 55), true))).toBe(iso(at(8, 0, 16))); // 22:05 is outside: tomorrow at 08:00
    expect(iso(nextCheck({ ...every, days: ["sat"] }, TZ, null, null, at(9, 0), true))).toBe(iso(at(0, 0, 17)));
  });
});

describe("background work across processes", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let src: string;

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } } });
    acc = (await api.data.accounts.create("Jobs")).id;
    await api.data.withAccount(acc, (s) => s.db.updateTable("accounts").set({ time_zone: TZ }).execute());
    const key = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    src = (await api.public.inject({ method: "POST", url: "/v1/sources", payload: { name: "Kitchen", type: "browser" }, headers: { authorization: `Bearer ${key}` } })).json().id;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("runs a job once per interval whichever process claims it, and keeps its state", async () => {
    const runs: unknown[] = [];
    const job: Job = { name: "test.count", everyS: 60, run: async (state) => {
      runs.push(state);
      await new Promise((r) => setTimeout(r, 50));
      return { n: ((state as { n?: number } | null)?.n ?? 0) + 1 };
    } };
    const t0 = Date.parse("2026-10-15T09:00:00Z");
    const all = (t: number) => Promise.all(["a", "b", "c"].map((w) => runDueJobs(api.data, [job], log, new Date(t), w)));
    expect((await all(t0)).flat()).toEqual(["test.count"]); // three processes, one run
    expect((await all(t0 + 30_000)).flat()).toEqual([]); // not due again yet
    expect((await all(t0 + 61_000)).flat()).toEqual(["test.count"]);
    expect(runs).toEqual([null, { n: 1 }]);
  });

  it("lets another process take over a job whose process died mid-run", async () => {
    const job: Job = { name: "test.crash", everyS: 30, leaseS: 120, run: async () => ({ done: true }) };
    const t0 = Date.parse("2026-10-15T10:00:00Z");
    // Process "a" claims it and never finishes.
    await sql`select * from claim_jobs(${["test.crash:30:120"]}, ${"a"}, ${new Date(t0)})`.execute(api.data.db());
    expect(await runDueJobs(api.data, [job], log, new Date(t0 + 60_000), "b")).toEqual([]); // still a's
    expect(await runDueJobs(api.data, [job], log, new Date(t0 + 121_000), "b")).toEqual(["test.crash"]);
  });

  it("records a failed run and runs it again next interval", async () => {
    let n = 0;
    const job: Job = { name: "test.fail", everyS: 30, run: async () => { if (++n === 1) throw new Error("boom"); } };
    const t0 = Date.parse("2026-10-15T11:00:00Z");
    expect(await runDueJobs(api.data, [job], log, new Date(t0), "a")).toEqual(["test.fail"]);
    expect(await runDueJobs(api.data, [job], log, new Date(t0 + 10_000), "b")).toEqual([]); // a failure waits for the interval too
    expect(await runDueJobs(api.data, [job], log, new Date(t0 + 31_000), "b")).toEqual(["test.fail"]);
    expect(n).toBe(2);
  });

  it("checks a scheduled watch in one process only", async () => {
    const id = "wat_jobs1";
    await api.data.withAccount(acc, (s) => s.db.insertInto("watches").values({
      id, account_id: acc, instruction: "Nobody in the kitchen by 10", sources: [src], mode: "alert",
      compiled: JSON.stringify({ trigger: { type: "condition", query: { measure: "count", what: { label: "person" } }, test: { op: "eq", value: 0 }, at: "10:00" }, cooldown_s: 0, active_hours: null }),
      estimate: JSON.stringify({}), status: "active", warnings: [], compiler: "user",
    } as never).execute());
    const row = () => api.data.withAccount(acc, (s) => s.db.selectFrom("watches").select(["next_check_at", "claimed_until", "last_checked_at"]).where("id", "=", id).executeTakeFirstOrThrow());
    expect(new Date((await row()).next_check_at!).getTime()).toBe(0); // new: due at once
    // Nothing recorded, so the camera can't tell and nothing fires; what matters is that one process checks it.
    await Promise.all([1, 2, 3].map(() => runScheduledWatches(api.data, log, at(10, 1))));
    const r = await row();
    expect(r.claimed_until).toBeNull();
    expect(iso(new Date(r.next_check_at!).getTime())).toBe(iso(at(10, 0, 16)));
    expect(iso(new Date(r.last_checked_at!).getTime())).toBe(iso(at(10, 1)));
    // Pausing clears the next check; resuming makes it due at once.
    await api.data.withAccount(acc, (s) => s.db.updateTable("watches").set({ status: "paused" }).where("id", "=", id).execute());
    expect((await row()).next_check_at).toBeNull();
    await api.data.withAccount(acc, (s) => s.db.updateTable("watches").set({ status: "active" }).where("id", "=", id).execute());
    expect(new Date((await row()).next_check_at!).getTime()).toBe(0);
  });

  it("fires a scheduled watch once when several processes check it together", async () => {
    // Recorded 08:00–11:00, nobody seen: "nobody by 10" holds.
    for (let t = at(8, 0, 20); t < at(11, 0, 20); t += 10 * 60_000) {
      await handleMediaEvent(api.data, "media.segment.written", { account_id: acc, source_id: src, key: `raw/${t}.m4s`, init_key: "raw/init.mp4",
        start: iso(t), duration_ms: 10 * 60_000, bytes: 1, codec: "h264" }, log);
    }
    const id = "wat_jobs2";
    await api.data.withAccount(acc, (s) => s.db.insertInto("watches").values({
      id, account_id: acc, instruction: "No one in the kitchen this morning", sources: [src], mode: "alert",
      compiled: JSON.stringify({ trigger: { type: "condition", query: { measure: "count", what: { label: "person" }, between: { from: "08:00", to: "10:00" } }, test: { op: "eq", value: 0 }, at: "10:00" }, cooldown_s: 0, active_hours: null }),
      estimate: JSON.stringify({}), status: "active", warnings: [], compiler: "user",
    } as never).execute());
    const fired = await Promise.all([1, 2, 3, 4].map(() => runScheduledWatches(api.data, log, at(10, 2, 20))));
    expect(fired.reduce((a, b) => a + b, 0)).toBe(1);
    const events = await api.data.withAccount(acc, (s) => s.db.selectFrom("events").select("summary").where("watch_id", "=", id).execute());
    expect(events.map((e) => e.summary)).toEqual(["No one in the kitchen this morning: 0 times."]);
  });

  it("hands each webhook delivery to one process", async () => {
    const hook = await api.data.withAccount(acc, (s) => s.db.insertInto("webhooks").values({ id: "whk_jobs", account_id: acc, url: "https://example.com/h", events: ["*"], secret: "x" }).returning("id").executeTakeFirstOrThrow());
    const ev = (await api.data.withAccount(acc, (s) => createEvent(s, { event_key: "jobs-dlv", source_id: src, type: "detection.person", sense: "video",
      occurred_at: new Date(), summary: "Person", labels: ["person"], confidence: 0.9 })))!;
    await api.data.withAccount(acc, (s) => s.db.insertInto("webhook_deliveries").values(
      Array.from({ length: 30 }, (_, i) => ({ id: `dlv_jobs${i}`, account_id: acc, webhook_id: hook.id, event_id: ev.id, next_attempt_at: new Date(Date.now() - 1000) }))).execute());
    const claim = () => sql<{ id: string }>`select * from claim_webhook_deliveries(${12}, ${60})`.execute(api.data.db()).then((r) => r.rows.map((x) => x.id));
    const got = (await Promise.all([claim(), claim(), claim(), claim()])).flat().filter((id) => id.startsWith("dlv_jobs"));
    expect(got).toHaveLength(30);
    expect(new Set(got).size).toBe(30);
    expect((await claim()).filter((id) => id.startsWith("dlv_jobs"))).toEqual([]); // all leased
  });
});
