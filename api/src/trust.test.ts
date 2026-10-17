// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Agents and grants, audit, usage meters, limits, export and deletion.
// Needs the compose Postgres and object store (like the playback tests).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiBus, createApi, handleBrainEvent, type SenseplaneApi } from "./index.js";
import { meterSegment } from "./indexer.js";
import type { Quota } from "./module.js";
import { purgeDeletedAccounts } from "./purge.js";
import { enforceLimits, sampleStorage } from "./routes/usage.js";
import { createTestDatabase } from "./testdb.js";

const S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://localhost:59000", region: "us-east-1", bucket: "senseplane",
  accessKeyId: "senseplane", secretAccessKey: "senseplane-secret", forcePathStyle: true,
};
const log = { warn() {}, error() {}, info() {} } as never;

describe("grants, audit, metering, limits", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let owner: string;
  let acc: string;
  let cam: string;
  let sensor: string;
  const kv = new Map<string, unknown>();
  const disconnected: string[] = [];
  let quota: Quota = { maxSources: null, maxRetentionDays: null };
  const bus: ApiBus = {
    async putSourceConfig() {},
    async latestSnapshot() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); },
    async putWatch(a, w, v) { if (v) kv.set(`${a}.${w}`, v); else kv.delete(`${a}.${w}`); },
    async close() {},
    async request<T>(subject: string): Promise<T> {
      if (subject === "rpc.brain.compile") return { compiled: { trigger: { type: "objects", label: "person", on: "enter" }, cooldown_s: 60, active_hours: null }, estimate: {}, warnings: [], compiler: "rules", needs_zone: false } as T;
      if (subject === "rpc.brain.embed") return { vectors: [[1, ...new Array(383).fill(0)]] } as T;
      if (subject === "rpc.brain.ask") return { answer: "A dog.", confidence: 0.9 } as T;
      throw new Error(subject);
    },
  };

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false, bus, storage: S3,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; }, async disconnect(id) { disconnected.push(id); } },
      modules: [{ name: "plan", register() {}, async quotaFor() { return quota; } }],
    });
    acc = (await api.data.accounts.create("Trust")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    cam = (await call(owner, "POST", "/v1/sources", { name: "Door", type: "browser", record_audio: true })).json().id;
    sensor = (await call(owner, "POST", "/v1/sources", { name: "Kitchen", type: "sensor" })).json().id;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });
  const call = (key: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const event = (type: string, sense: string, key: string, at = new Date()) =>
    handleBrainEvent(api.data, undefined, "brain.event", {
      event_key: key, account_id: acc, source_id: cam, type, sense, occurred_at: at.toISOString(), labels: type.startsWith("sound") ? ["crying"] : ["person"], confidence: 0.9,
      summary: type.startsWith("sound") ? "Heard crying." : "A person was seen.",
    }, log, async () => [[1, ...new Array(383).fill(0)]]);

  it("a video-only agent sees the camera without audio, and no sound events", async () => {
    const agent = (await call(owner, "POST", "/v1/agents", { name: "Doorbot" })).json();
    expect(agent.api_key).toMatch(/^sk_/);
    const g = await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [cam], senses: ["video"] });
    expect(g.statusCode).toBe(201);
    await event("detection.person", "video", "e1");
    await event("sound.detected", "audio", "e2");
    const k = agent.api_key;
    const list = (await call(k, "GET", "/v1/sources")).json().data;
    expect(list).toEqual([expect.objectContaining({ id: cam, senses: ["video"] })]); // no sensor, no audio
    expect((await call(k, "GET", `/v1/sources/${sensor}`)).statusCode).toBe(404);
    const evs = (await call(k, "GET", "/v1/events")).json().data.map((e: { type: string }) => e.type);
    expect(evs).toEqual(["detection.person"]);
    expect((await call(k, "GET", "/v1/memory/search?q=crying")).json().data.every((h: { event: { type: string } }) => h.event.type !== "sound.detected")).toBe(true);
    expect((await call(k, "POST", `/v1/sources/${cam}/ask`, { question: "What is there?" })).statusCode).toBe(200);
    expect((await call(k, "GET", `/v1/sources/${cam}/now`)).json().snapshot_url).toBeTruthy();
    // Owner-only endpoints are refused.
    const f = await call(k, "POST", "/v1/sources", { name: "x", type: "browser" });
    expect(f.statusCode).toBe(403);
    expect(f.json().error.code).toBe("forbidden");
    expect((await call(k, "GET", "/v1/audit")).statusCode).toBe(403);
    // A window in the past: no live access, and no recorded data outside it.
    await call(owner, "DELETE", `/v1/grants/${g.json().id}`);
    const past = await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [cam], senses: ["video"], window: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" } });
    expect(past.statusCode).toBe(201);
    const ask = await call(k, "POST", `/v1/sources/${cam}/ask`, { question: "What is there?" });
    expect(ask.statusCode).toBe(403);
    expect(ask.json().error.code).toBe("forbidden_sense");
    expect((await call(k, "GET", "/v1/events")).json().data).toEqual([]);
  });

  it("revokes on the next request: grant deletion and agent deletion", async () => {
    const agent = (await call(owner, "POST", "/v1/agents", { name: "Temp" })).json();
    const g = (await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [cam], senses: ["video", "audio"] })).json();
    expect((await call(agent.api_key, "GET", `/v1/sources/${cam}/now`)).statusCode).toBe(200);
    await call(owner, "DELETE", `/v1/grants/${g.id}`);
    expect((await call(agent.api_key, "GET", `/v1/sources/${cam}/now`)).statusCode).toBe(404);
    expect((await call(owner, "DELETE", `/v1/agents/${agent.id}`)).statusCode).toBe(204);
    expect((await call(agent.api_key, "GET", "/v1/sources")).statusCode).toBe(401);
  });

  it("audits every request with its actor", async () => {
    const entries = (await call(owner, "GET", "/v1/audit?limit=100")).json().data;
    expect(entries.some((e: { actor: string; action: string }) => e.actor.startsWith("agent:agt_") && e.action === "POST /v1/sources/:id/ask")).toBe(true);
    expect(entries.some((e: { actor: string; status: number }) => e.actor.startsWith("agent:") && e.status === 403)).toBe(true);
    expect(entries.some((e: { actor: string }) => e.actor.startsWith("owner:sk_"))).toBe(true);
  });

  it("meters camera-minutes by resolution, storage and AI checks exactly", async () => {
    const start = Date.parse("2026-10-16T08:00:00Z");
    // 100 segments of 6 s at 720p and 50 at 1080p = 10 + 5 minutes; one redelivered.
    for (let i = 0; i < 150; i++) {
      const big = i >= 100;
      await meterSegment(api.data, acc, cam, { key: `raw/${acc}/${cam}/k${i}.m4s`, start: new Date(start + i * 6000).toISOString(), duration_ms: 6000, width: big ? 1920 : 1280, height: big ? 1080 : 720 });
    }
    await meterSegment(api.data, acc, cam, { key: `raw/${acc}/${cam}/k0.m4s`, start: new Date(start).toISOString(), duration_ms: 6000, width: 1280, height: 720 });
    for (const [detail, n] of [["verify", 7], ["ask", 3], ["compile", 2]] as const) {
      for (let i = 0; i < n; i++) await handleBrainEvent(api.data, undefined, "brain.usage", { id: `${detail}-${i}`, account_id: acc, kind: "ai_checks", detail, quantity: 1, at: new Date(start).toISOString() }, log);
    }
    await handleBrainEvent(api.data, undefined, "brain.usage", { id: "verify-0", account_id: acc, kind: "ai_checks", detail: "verify", quantity: 1, at: new Date(start).toISOString() }, log); // redelivered
    const ur = await call(owner, "GET", "/v1/usage?from=2026-10-16T00:00:00Z&to=2026-10-17T00:00:00Z");
    if (ur.statusCode !== 200) console.log(ur.body);
    const u = ur.json();
    expect(u.camera_minutes).toBe(15);
    expect(u.camera_minutes_by_resolution).toEqual({ "720p": 10, "1080p": 5 });
    expect(u.ai_checks).toBe(12);
    expect(u.ai_checks_by_kind).toMatchObject({ verify: 7, ask: 3, compile: 2, look: 0, summary: 0 });
    expect(u.sources).toMatchObject({ registered: 2, active: 0, max_registered: null, max_active: null });
    // Storage: one sample per hour, idempotent.
    await api.data.withAccount(acc, (s) => s.segments.insert({ source_id: cam, key: "raw/x/1.m4s", init_key: "raw/x/i.mp4", start_at: new Date(start).toISOString(), duration_ms: 6000, bytes: 2_000_000_000, codec: "h264", has_audio: false }));
    await sampleStorage(api.data, new Date("2026-10-16T09:10:00Z"));
    await sampleStorage(api.data, new Date("2026-10-16T09:40:00Z"));
    await sampleStorage(api.data, new Date("2026-10-16T10:05:00Z"));
    const u2 = (await call(owner, "GET", "/v1/usage?from=2026-10-16T00:00:00Z&to=2026-10-17T00:00:00Z")).json();
    expect(u2.storage_gb_hours).toBe(4); // 2 GB × 2 hourly samples
  });

  it("limits registered and streaming sources, and usage", async () => {
    const garage = (await call(owner, "POST", "/v1/sources", { name: "Garage", type: "browser" })).json();
    const ticket = new URLSearchParams(new URL(garage.ingest.capture_url).hash.slice(1)).get("t");
    quota = { maxSources: 3, maxActiveSources: 1, maxRetentionDays: null };
    const r = await call(owner, "POST", "/v1/sources", { name: "Third", type: "browser" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("source_limit_reached");
    // One source streaming already: the other camera can't join.
    await api.data.withAccount(acc, (s) => s.sources.setStatus(sensor, "online"));
    const join = await api.public.inject({ method: "POST", url: "/v1/capture/join", payload: { ticket } });
    expect(join.statusCode).toBe(409);
    expect(join.json().error).toMatchObject({ code: "source_limit_reached", message: expect.stringContaining("camera limit") });
    const u = (await call(owner, "GET", "/v1/usage")).json();
    expect(u.sources).toMatchObject({ registered: 3, active: 1, max_registered: 3, max_active: 1 });
    // AI-check limit: watches pause, ask refuses.
    quota = { ...quota, usageLimits: [{ meter: "ai_checks", period: "month", limit: 10 }] };
    kv.set(`${acc}.wat_x`, {});
    for (let i = 0; i < 10; i++) await handleBrainEvent(api.data, undefined, "brain.usage", { id: `now-${i}`, account_id: acc, kind: "ai_checks", detail: "verify", quantity: 1, at: new Date().toISOString() }, log);
    const over = await enforceLimits({ data: api.data, bus, quotaFor: async () => quota });
    expect(over.get(acc)).toEqual(["ai_checks"]);
    const ask = await call(owner, "POST", `/v1/sources/${cam}/ask`, { question: "Anything?" });
    expect(ask.statusCode).toBe(429);
    expect(ask.json().error.code).toBe("allowance_exhausted");
    // A notify limit only reports: nothing pauses, ask still works.
    const reported: string[] = [];
    quota = { ...quota, usageLimits: [{ meter: "ai_checks", period: "month", limit: 10, enforcement: "notify" }] };
    const notifyOver = await enforceLimits({ data: api.data, bus, quotaFor: async () => quota, onUsageLimit: async (a, m) => void reported.push(`${a}:${m}`) });
    expect(notifyOver.has(acc)).toBe(false);
    expect(reported).toContain(`${acc}:ai_checks`);
    expect((await call(owner, "POST", `/v1/sources/${cam}/ask`, { question: "Anything?" })).json().error?.code).not.toBe("allowance_exhausted");
    // A hard camera-time limit disconnects live cameras with the allowance reason.
    const disconnected: string[] = [];
    quota = { ...quota, usageLimits: [{ meter: "camera_minutes", period: "month", limit: 0 }] };
    await enforceLimits({ data: api.data, bus, quotaFor: async () => quota, media: { createIngestSession: async () => ({ id: "s", publish_url: "ws://m" }), disconnect: async (id, reason) => void disconnected.push(`${id}:${reason}`) } });
    expect(disconnected).toContain(`${sensor}:allowance_exhausted`);
    quota = { maxSources: null, maxRetentionDays: null };
  });

  it("exports the account and deletes it", async () => {
    const e = await call(owner, "POST", "/v1/account/export");
    expect(e.statusCode).toBe(202);
    const body = e.json();
    expect(body.status).toBe("ready");
    const doc = await (await fetch(body.url.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${await port()}`))).json();
    expect(doc.format).toBe("senseplane-export/1");
    expect(doc.sources).toHaveLength(3);
    expect(doc.events.length).toBeGreaterThan(0);
    expect(doc.audit.length).toBeGreaterThan(0);
    expect((await call(owner, "DELETE", "/v1/account")).statusCode).toBe(202);
    expect((await call(owner, "GET", "/v1/sources")).statusCode).toBe(401); // keys revoked at once
    expect(await purgeDeletedAccounts({ data: api.data, bus, storage: undefined })).toBe(1);
    expect(await api.data.withAccount(acc, (s) => s.db.selectFrom("events").selectAll().execute())).toEqual([]);
    expect(await api.data.withAccount(acc, (s) => s.db.selectFrom("audit_log").selectAll().execute())).toEqual([]);
  });

  let listening: number | undefined;
  async function port() {
    if (!listening) {
      await api.public.listen({ port: 0, host: "127.0.0.1" });
      listening = (api.public.server.address() as { port: number }).port;
    }
    return listening;
  }
});
