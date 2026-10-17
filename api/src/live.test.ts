// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Live view (ADR 0042): grants, the quota hook, viewer caps, metering and the account's limits.
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type Quota, type SenseplaneApi } from "./index.js";
import { handleViewerEvent, sweepLiveSessions } from "./routes/live.js";
import { fakeMediaPlane } from "./testkit.js";
import { enforceLimits } from "./routes/usage.js";
import { createTestDatabase } from "./testdb.js";

const UNLIMITED: Quota = { maxSources: null, maxRetentionDays: null };

describe("live view", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let key: string;
  let accountId: string;
  let cam: string;
  let micCam: string;
  const plane = fakeMediaPlane();
  const streaming = { add(id: string) { plane.publish(id); return streaming; } };
  const disconnected: string[] = [];
  const quotas = new Map<string, Quota>();

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, workers: false, sweepIntervalSeconds: 0,
      captureUrl: "https://console.test/capture.html", liveIdleTimeoutSeconds: 600,
      modules: [{ name: "plans", quotaFor: async (id) => quotas.get(id) }],
      media: { control: plane.client },
    });
    accountId = (await api.data.accounts.create("Live")).id;
    key = (await api.data.withAccount(accountId, (s) => s.apiKeys.create("t"))).key;
    cam = (await call("POST", "/v1/sources", { name: "Front door", type: "browser" })).json().id;
    micCam = (await call("POST", "/v1/sources", { name: "Nursery", type: "browser", record_audio: true })).json().id;
    streaming.add(cam).add(micCam);
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  function call(method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, k = key) {
    return api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${k}` } });
  }
  const verify = async (token: string) => {
    const jwks = (await api.public.inject({ method: "GET", url: "/.well-known/senseplane-ingest-jwks.json" })).json();
    return (await jwtVerify(token, createLocalJWKSet(jwks), { audience: "media" })).payload;
  };
  const endAll = () => api.data.withAccount(accountId, (s) => s.db.updateTable("live_sessions").set({ ended_at: new Date() }).where("ended_at", "is", null).execute());

  it("issues a single-use, subscribe-only viewer token and audits it", async () => {
    const r = await call("POST", `/v1/sources/${cam}/live`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ media_url: "ws://media.test/", idle_timeout_seconds: 600, audio: false });
    expect(body.session_id).toMatch(/^lv_/);
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
    const claims = await verify(body.token);
    expect(claims).toMatchObject({ room: `sp-${cam}`, identity: `${cam}:viewer:${body.session_id}`, jti: body.session_id, kind: "human", transport: "webrtc" });
    expect(claims.grants).toEqual({ canPublish: false, canSubscribe: true, canPublishData: false, subscribeKinds: ["video"], idleTimeoutSeconds: 600 });
    expect((claims.exp as number) - (claims.iat as number)).toBe(60);
    const audit = (await call("GET", "/v1/audit")).json().data as { action: string; target: string; details?: { session_id?: string } }[];
    expect(audit.some((a) => a.action === "live.start" && a.target === cam)).toBe(true);
    await endAll();
  });

  it("includes audio only when asked for and the source has it", async () => {
    const withMic = (await call("POST", `/v1/sources/${micCam}/live`, { audio: true })).json();
    expect(withMic.audio).toBe(true);
    expect(((await verify(withMic.token)).grants as { subscribeKinds: string[] }).subscribeKinds).toEqual(["video", "audio"]);
    const notAsked = (await call("POST", `/v1/sources/${micCam}/live`, { audio: false })).json();
    expect(((await verify(notAsked.token)).grants as { subscribeKinds: string[] }).subscribeKinds).toEqual(["video"]);
    const noMic = (await call("POST", `/v1/sources/${cam}/live`, { audio: true })).json();
    expect(noMic.audio).toBe(false);
    expect((await call("POST", `/v1/sources/${cam}/live`, { audio: "yes" })).statusCode).toBe(400);
    await endAll();
  });

  it("enforces grants: video required, audio only with an audio grant", async () => {
    const agentKey = async (senses: string[], sources = [micCam]) => {
      const agent = (await call("POST", "/v1/agents", { name: `Agent ${senses.join("+")}` })).json();
      if (senses.length) await call("POST", "/v1/grants", { agent_id: agent.id, source_ids: sources, senses });
      return agent.api_key as string;
    };
    const videoOnly = await agentKey(["video"]);
    const ok = await call("POST", `/v1/sources/${micCam}/live`, {}, videoOnly);
    expect(ok.statusCode).toBe(200);
    expect(((await verify(ok.json().token)).grants as { subscribeKinds: string[] }).subscribeKinds).toEqual(["video"]);
    const noAudio = await call("POST", `/v1/sources/${micCam}/live`, { audio: true }, videoOnly);
    expect(noAudio.statusCode).toBe(403);
    expect(noAudio.json().error.code).toBe("forbidden_sense");

    const audioOnly = await agentKey(["audio"]);
    expect((await call("POST", `/v1/sources/${micCam}/live`, {}, audioOnly)).json().error.code).toBe("forbidden_sense");
    expect((await call("POST", `/v1/sources/${cam}/live`, {}, videoOnly)).statusCode).toBe(404); // not granted at all

    const both = await agentKey(["video", "audio"]);
    const av = await call("POST", `/v1/sources/${micCam}/live`, { audio: true }, both);
    expect(((await verify(av.json().token)).grants as { subscribeKinds: string[] }).subscribeKinds).toEqual(["video", "audio"]);
    await endAll();
  });

  it("refuses sources that aren't streaming, sensors and unknown sources", async () => {
    const idle = (await call("POST", "/v1/sources", { name: "Garage", type: "browser" })).json().id;
    const r = await call("POST", `/v1/sources/${idle}/live`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("conflict");
    const sensor = (await call("POST", "/v1/sources", { name: "Thermo", type: "sensor" })).json().id;
    expect((await call("POST", `/v1/sources/${sensor}/live`)).json().error.code).toBe("conflict");
    expect((await call("POST", "/v1/sources/src_nope/live")).statusCode).toBe(404);
  });

  it("answers feature_not_available when the quota provider turns live view off", async () => {
    quotas.set(accountId, { ...UNLIMITED, liveView: false, planLabel: "Basic" });
    const r = await call("POST", `/v1/sources/${cam}/live`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatchObject({ code: "feature_not_available", details: { feature: "live_view" } });
    const acct = (await call("GET", "/v1/account")).json();
    expect(acct.limits).toMatchObject({ live_view: false });
    expect(acct.plan_label).toBe("Basic");
    quotas.delete(accountId);
  });

  it("caps people watching at once with limit_reached", async () => {
    quotas.set(accountId, { ...UNLIMITED, maxLiveViewers: 2 });
    const a = await call("POST", `/v1/sources/${cam}/live`);
    const b = await call("POST", `/v1/sources/${micCam}/live`);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(((await verify(a.json().token)).grants as { maxLiveViewers: number }).maxLiveViewers).toBe(2);
    const c = await call("POST", `/v1/sources/${cam}/live`);
    expect(c.statusCode).toBe(429);
    expect(c.json().error).toMatchObject({ code: "limit_reached", details: { limit: "max_live_viewers", max: 2 } });
    // A viewer that left frees its place (room events: participant.joined / participant.left).
    await handleViewerEvent(api.data, accountId, "joined", a.json().session_id, new Date());
    await handleViewerEvent(api.data, accountId, "left", a.json().session_id, new Date(), "left");
    expect((await call("POST", `/v1/sources/${cam}/live`)).statusCode).toBe(200);
    quotas.delete(accountId);
    await endAll();
  });

  it("meters viewer-minutes per source and per UTC day, and ends idle viewers", async () => {
    const acc = (await api.data.accounts.create("Meter")).id;
    const k = (await api.data.withAccount(acc, (s) => s.apiKeys.create("m"))).key;
    const src = (await call("POST", "/v1/sources", { name: "Shop", type: "browser" }, k)).json().id;
    streaming.add(src);
    await api.data.withAccount(acc, (s) => s.db.updateTable("sources").set({ status: "online" }).where("id", "=", src).execute());
    const s1 = (await call("POST", `/v1/sources/${src}/live`, {}, k)).json().session_id;
    const s2 = (await call("POST", `/v1/sources/${src}/live`, {}, k)).json().session_id;
    const t0 = Date.parse("2026-10-15T23:59:00Z");
    const at = (ms: number) => new Date(t0 + ms);
    await handleViewerEvent(api.data, acc, "joined", s1, at(0));
    await handleViewerEvent(api.data, acc, "joined", s2, at(0));
    await handleViewerEvent(api.data, acc, "joined", s2, at(5000)); // redelivery: no change
    // The console says it is still watching; keepalive needs the account's key.
    expect((await call("POST", `/v1/live/${s1}/keepalive`, undefined, k)).json()).toEqual({ idle_timeout_seconds: 600 });
    expect((await call("POST", `/v1/live/${s1}/keepalive`)).statusCode).toBe(404);
    await api.data.withAccount(acc, (s) => s.db.updateTable("live_sessions").set({ last_seen_at: at(0) }).where("id", "in", [s1, s2]).execute());
    await sweepLiveSessions(api.data, { idleTimeoutSeconds: 600, now: at(60_000) });
    await sweepLiveSessions(api.data, { idleTimeoutSeconds: 600, now: at(60_000) }); // a second pass: no double count
    expect((await call("GET", "/v1/usage", undefined, k)).json().live_viewers_now).toBe(2);
    await handleViewerEvent(api.data, acc, "left", s1, at(90_000), "left");
    // s2 shows no sign of life: the sweep ends it as idle and removes it from the room.
    const removed: string[] = [];
    await sweepLiveSessions(api.data, {
      idleTimeoutSeconds: 120, now: at(150_000),
      media: { prepareCamera: async () => ({ signalUrl: "" }), removeViewer: async (source, sid, reason) => void removed.push(`${source}:${sid}:${reason}`) },
    });
    expect(removed).toEqual([`${src}:${s2}:idle`]);

    const usage = (await call("GET", `/v1/usage?from=2026-10-15T00:00:00Z&to=2026-10-17T00:00:00Z`, undefined, k)).json();
    expect(usage.live_view_minutes).toBe(4); // 1.5 + 2.5
    expect(usage.live_view_minutes_by_source).toEqual({ [src]: 4 });
    const days = Object.fromEntries((usage.by_day as { day: string; live_view_minutes: number }[]).map((d) => [d.day, d.live_view_minutes]));
    expect(days).toEqual({ "2026-10-15": 2, "2026-10-16": 2 }); // split at midnight
    expect(usage.live_viewers_now).toBe(0);
    const rows = await api.data.withAccount(acc, (s) => s.db.selectFrom("live_sessions").select(["id", "end_reason"]).orderBy("id").execute());
    expect(Object.fromEntries(rows.map((r) => [r.id, r.end_reason]))).toEqual({ [s1]: "left", [s2]: "idle" });
  });

  it("ends viewers of a camera gone for the grace period, and closes tokens never used", async () => {
    const acc = (await api.data.accounts.create("Sweep")).id;
    const k = (await api.data.withAccount(acc, (s) => s.apiKeys.create("s"))).key;
    const src = (await call("POST", "/v1/sources", { name: "Yard", type: "browser" }, k)).json().id;
    streaming.add(src);
    const joined = (await call("POST", `/v1/sources/${src}/live`, {}, k)).json().session_id;
    const unused = (await call("POST", `/v1/sources/${src}/live`, {}, k)).json().session_id;
    await handleViewerEvent(api.data, acc, "joined", joined, new Date());
    await api.data.withAccount(acc, (s) => s.db.updateTable("live_sessions").set({ expires_at: new Date(Date.now() - 1000) }).where("id", "=", unused).execute());
    // The camera goes offline (status_since is set by the database on the change); the sweep runs a minute later.
    await api.data.withAccount(acc, (s) => s.db.updateTable("sources").set({ status: "offline" }).where("id", "=", src).execute());
    expect(await sweepLiveSessions(api.data, { idleTimeoutSeconds: 600, offlineGraceSeconds: 30, now: new Date(Date.now() + 60_000) })).toBe(2);
    const rows = await api.data.withAccount(acc, (s) => s.db.selectFrom("live_sessions").select(["id", "end_reason", "ended_at"]).execute());
    expect(Object.fromEntries(rows.map((r) => [r.id, r.end_reason]))).toEqual({ [joined]: "source_offline", [unused]: "not_joined" });
  });

  it("stops new viewers and ends current ones at a hard live_view_minutes allowance, without touching cameras", async () => {
    const acc = (await api.data.accounts.create("Allowance")).id;
    const k = (await api.data.withAccount(acc, (s) => s.apiKeys.create("a"))).key;
    const src = (await call("POST", "/v1/sources", { name: "Hall", type: "browser" }, k)).json().id;
    streaming.add(src);
    await api.data.withAccount(acc, (s) => s.db.updateTable("sources").set({ status: "online" }).where("id", "=", src).execute());
    const watching = (await call("POST", `/v1/sources/${src}/live`, {}, k)).json().session_id;
    await handleViewerEvent(api.data, acc, "joined", watching, new Date());
    await api.data.withAccount(acc, (s) =>
      s.db.insertInto("usage_records").values({ account_id: acc, source_id: src, kind: "live_view_ms", quantity: 6 * 60_000, at: new Date() }).execute());
    const q: Quota = { ...UNLIMITED, usageLimits: [{ meter: "live_view_minutes", period: "month", limit: 5 }] };
    quotas.set(acc, q);
    const r = await call("POST", `/v1/sources/${src}/live`, {}, k);
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toMatchObject({ code: "limit_reached", details: { limit: "live_view_minutes", max: 5 } });
    disconnected.length = 0;
    const removed: string[] = [];
    const media = {
      prepareCamera: async () => ({ signalUrl: "ws://m" }),
      disconnect: async (id: string) => void disconnected.push(id),
      removeViewer: async (_s: string, sid: string, reason: string) => void removed.push(`${sid}:${reason}`),
    };
    const over = await enforceLimits({ data: api.data, media, quotaFor: async (id) => quotas.get(id) ?? UNLIMITED });
    expect(over.get(acc)).toEqual(["live_view_minutes"]);
    expect(removed).toEqual([`${watching}:allowance_exhausted`]);
    expect(disconnected).toEqual([]);
    const ended = await api.data.withAccount(acc, (s) => s.db.selectFrom("live_sessions").select("end_reason").where("id", "=", watching).executeTakeFirst());
    expect(ended?.end_reason).toBe("allowance_exhausted");
    // Capture still works: live view minutes are not an ingest allowance.
    expect((await call("GET", "/v1/account", undefined, k)).json().limits).toMatchObject({ live_view_minutes: 5 });
    quotas.delete(acc);
  });

  it("reports the self-host limits: live view on, everything unlimited", async () => {
    const acct = (await call("GET", "/v1/account")).json();
    expect(acct.limits).toEqual({ live_view: true, live_view_minutes: null, max_live_viewers: null, camera_minutes: null, storage_gb: null, ai_checks: null });
    expect(acct.plan_label).toBeNull();
    quotas.set(accountId, {
      ...UNLIMITED, maxLiveViewers: 3, planLabel: "Team",
      usageLimits: [
        { meter: "camera_minutes", period: "day", limit: 100 },
        { meter: "camera_minutes", period: "month", limit: 1000 },
        { meter: "ai_checks", period: "month", limit: 50 },
        { meter: "storage_gb", period: "month", limit: 20 },
        { meter: "live_view_minutes", period: "month", limit: 300 },
      ],
    });
    expect((await call("GET", "/v1/account")).json()).toMatchObject({
      plan_label: "Team",
      limits: { live_view: true, live_view_minutes: 300, max_live_viewers: 3, camera_minutes: 1000, storage_gb: 20, ai_checks: 50 },
    });
    quotas.delete(accountId);
  });
});
