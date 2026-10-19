// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Activities (ADR 0057) against Postgres: storing the brain's messages,
// closing stale ones, and questions through the API within grants.
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeStaleActivities } from "./activity.js";
import { storeActivity } from "./brain-events.js";
import { createApi, type SenseplaneApi } from "./index.js";
import { handleMediaEvent } from "./indexer.js";
import { createTestDatabase } from "./testdb.js";

const log = { warn() {}, error() {}, info() {} } as never;
const iso = (t: number) => new Date(t).toISOString();

describe("activities", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let owner: string;
  let kitchen: string;
  let hall: string;
  const call = (key: string, method: "GET" | "POST", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const now = Date.now();
  const H = 3600_000;
  // Recorded from 6 h ago until now, except one hour (4 h to 3 h ago) on the kitchen camera.
  const recorded = async (src: string, gaps: [number, number][] = []) => {
    for (let t = now - 6 * H; t < now; t += 60_000) {
      if (gaps.some(([a, b]) => t >= a && t < b)) continue;
      await handleMediaEvent(api.data, "media.segment.written", {
        account_id: acc, source_id: src, key: `raw/${acc}/${src}/${t}.m4s`, init_key: `raw/${acc}/${src}/init.mp4`, start: iso(t), duration_ms: 60_000, bytes: 1, codec: "h264",
      }, log);
    }
  };
  const act = (src: string, key: string, kind: string, label: string, start: number, end: number | null, extra: Record<string, unknown> = {}) =>
    storeActivity(api.data, acc, src, { activity_key: key, kind, label, zone: null, started_at: iso(start), last_seen_at: iso(end ?? start), ended_at: end === null ? null : iso(end), peak_count: 1, ...extra }, log);

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } } });
    acc = (await api.data.accounts.create("Activity")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    kitchen = (await call(owner, "POST", "/v1/sources", { name: "Kitchen", type: "browser", record_audio: true })).json().id;
    hall = (await call(owner, "POST", "/v1/sources", { name: "Hall", type: "browser" })).json().id;
    await recorded(kitchen, [[now - 4 * H, now - 3 * H]]);
    await recorded(hall);
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("keeps one row per activity: opened, kept going, closed, and never moved backwards", async () => {
    const s = now - 5 * H;
    await act(kitchen, "k1", "presence", "person", s, null);
    await act(kitchen, "k1", "presence", "person", s, s + 60_000);
    // ...where a heartbeat says "still going" until +2 min:
    await storeActivity(api.data, acc, kitchen, { activity_key: "k1", kind: "presence", label: "person", started_at: iso(s), last_seen_at: iso(s + 120_000), ended_at: null, peak_count: 3 }, log);
    let row = await api.data.withAccount(acc, (x) => x.db.selectFrom("activities").selectAll().where("activity_key", "=", "k1").executeTakeFirstOrThrow());
    expect(row.ended_at).toBeNull(); // the later heartbeat reopened what the earlier message closed
    expect(row.peak_count).toBe(3);
    await act(kitchen, "k1", "presence", "person", s, s + 10 * 60_000);
    await act(kitchen, "k1", "presence", "person", s, s + 30_000); // a late duplicate of an older message
    row = await api.data.withAccount(acc, (x) => x.db.selectFrom("activities").selectAll().where("activity_key", "=", "k1").executeTakeFirstOrThrow());
    expect(new Date(row.ended_at!).getTime()).toBe(s + 10 * 60_000);
    expect(new Date(row.last_seen_at).getTime()).toBe(s + 10 * 60_000);
    expect(row.peak_count).toBe(3);
  });

  it("ends an activity whose brain went quiet where it was last seen", async () => {
    await storeActivity(api.data, acc, hall, { activity_key: "h-stale", kind: "presence", label: "person", started_at: iso(now - 20 * 60_000), last_seen_at: iso(now - 10 * 60_000), ended_at: null }, log);
    await storeActivity(api.data, acc, hall, { activity_key: "h-live", kind: "presence", label: "cat", started_at: iso(now - 60_000), last_seen_at: iso(now - 10_000), ended_at: null }, log);
    expect(await closeStaleActivities(api.data)).toBeGreaterThanOrEqual(1);
    const rows = await api.data.withAccount(acc, (x) => x.db.selectFrom("activities").select(["activity_key", "ended_at", "last_seen_at"]).where("source_id", "=", hall).execute());
    const stale = rows.find((r) => r.activity_key === "h-stale")!;
    expect(new Date(stale.ended_at!).getTime()).toBe(new Date(stale.last_seen_at).getTime());
    expect(rows.find((r) => r.activity_key === "h-live")!.ended_at).toBeNull();
  });

  it("answers questions over the API: count, duration and coverage", async () => {
    await act(kitchen, "m1", "watch", "wat_eat", now - 5 * H, now - 5 * H + 20 * 60_000, { watch_id: "wat_eat", verified: true, summary: "Eating at the table." });
    await act(kitchen, "m2", "watch", "wat_eat", now - 2 * H, now - 2 * H + 25 * 60_000, { watch_id: "wat_eat", verified: true });
    await api.data.withAccount(acc, (x) => x.db.insertInto("watches").values({ id: "wat_eat", account_id: acc, instruction: "Track meals at the table", sources: [kitchen],
      mode: "track", compiled: JSON.stringify({ trigger: { type: "objects", label: "person", on: "present" } }) as never, estimate: JSON.stringify({}) as never, status: "active", warnings: [], compiler: "rules" } as never).execute());
    const r = await call(owner, "POST", "/v1/activity/query", { measure: "count", what: { watch_id: "wat_eat" }, period: "last_24_hours", sources: ["Kitchen"] });
    expect(r.statusCode).toBe(200);
    const a = r.json();
    expect(a.value).toBe(2);
    expect(a.evidence[0]).toMatchObject({ source_name: "Kitchen", duration_s: 1200, summary: "Eating at the table." });
    expect(a.coverage.complete).toBe(false); // nothing was recorded before 6 h ago, and the hour gap
    const d = (await call(owner, "POST", "/v1/activity/query", { measure: "total_duration", what: { watch_id: "wat_eat" }, from: iso(now - 6 * H) })).json();
    expect(d.value).toBe(45 * 60);
    expect(d.coverage.recorded).toBeCloseTo(11 / 12, 2); // kitchen 5 of 6 h, hall 6 of 6 h
    expect(d.coverage.gaps[0]).toMatchObject({ source_id: kitchen });
    const bad = await call(owner, "POST", "/v1/activity/query", { measure: "count", what: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/exactly one of/);
    expect((await call(owner, "POST", "/v1/activity/query", { measure: "count", what: { watch_id: "wat_none" } })).statusCode).toBe(404);
    expect((await call(owner, "POST", "/v1/activity/query", { measure: "count", what: { label: "person" }, sources: ["Garage"] })).statusCode).toBe(404);
  });

  it("lists activities", async () => {
    const list = (await call(owner, "GET", `/v1/activities?source=${kitchen}&kind=watch&from=${iso(now - 6 * H)}`)).json().data;
    expect(list.map((x: { label: string }) => x.label)).toEqual(["wat_eat", "wat_eat"]);
    expect(list[1]).toMatchObject({ source: { id: kitchen, name: "Kitchen" }, duration_s: 1200, ongoing: false, verified: true });
  });

  it("keeps an agent to its grants: senses, cameras and time window", async () => {
    await act(kitchen, "s1", "sound", "crying", now - H, now - H + 60_000);
    const agent = (await call(owner, "POST", "/v1/agents", { name: "Carer app" })).json();
    // Video on the kitchen only, and only from 3 h ago.
    expect((await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [kitchen], senses: ["video"], window: { from: iso(now - 3 * H) } })).statusCode).toBe(201);
    const k = agent.api_key;
    const meals = (await call(k, "POST", "/v1/activity/query", { measure: "count", what: { watch_id: "wat_eat" }, period: "last_24_hours" })).json();
    expect(meals.value).toBe(1); // the 5 h-ago meal is before its window
    const sounds = (await call(k, "POST", "/v1/activity/query", { measure: "count", what: { sound: "crying" }, period: "last_24_hours" })).json();
    expect(sounds.value).toBe(0); // no audio grant
    expect((await call(k, "POST", "/v1/activity/query", { measure: "count", what: { label: "person" }, sources: ["Hall"] })).statusCode).toBe(404);
    const owned = (await call(owner, "POST", "/v1/activity/query", { measure: "count", what: { sound: "crying" }, period: "last_24_hours" })).json();
    expect(owned.value).toBe(1);
    // The agent's activity list follows the same rules.
    const listed = (await call(k, "GET", `/v1/activities?from=${iso(now - 6 * H)}`)).json().data;
    expect(listed.every((x: { kind: string; source: { id: string } }) => x.kind !== "sound" && x.source.id === kitchen)).toBe(true);
  });

  it("hides activities from the app role without an account set (row-level security)", async () => {
    const n = await sql<{ n: number }>`select count(*)::int as n from activities`.execute(api.data.db());
    expect(n.rows[0]!.n).toBe(0);
  });
});
