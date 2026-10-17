// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleBrainEvent } from "./brain-events.js";
import { createApi, type SenseplaneApi } from "./index.js";
import { checkWebhookUrl } from "./routes/events.js";
import { createTestDatabase } from "./testdb.js";
import { deliverOnce } from "./workers.js";
import { guardedRequest } from "./egress.js";

const allowLocal = { allowPrivate: true, allowedHosts: [] };
const localSender = (url: string, req: Parameters<typeof guardedRequest>[1]) => guardedRequest(url, req, allowLocal);
import { createPlaybackSigner } from "./playback.js";

const log = { warn() {}, error() {}, info() {} } as never;

describe("events, webhooks, readings, source config", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let key: string;
  let acc: string;
  let src: string;
  const auth = () => ({ authorization: `Bearer ${key}` });

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } },
    });
    acc = (await api.data.accounts.create("Events")).id;
    key = (await api.data.withAccount(acc, (s) => s.apiKeys.create("t"))).key;
    src = (await api.public.inject({ method: "POST", url: "/v1/sources", headers: auth(), payload: { name: "Door", type: "browser", location: "Front door" } })).json().id;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("validates and stores zones and privacy masks", async () => {
    const bad = await api.public.inject({ method: "PATCH", url: `/v1/sources/${src}`, headers: auth(), payload: { zones: [{ name: "Front Door", polygon: [[0, 0], [1, 0]] }] } });
    expect(bad.json().error.code).toBe("validation_failed");
    const ok = await api.public.inject({
      method: "PATCH", url: `/v1/sources/${src}`, headers: auth(),
      payload: { zones: [{ name: "front_door", polygon: [[0, 0.5], [1, 0.5], [1, 1], [0, 1]] }], privacy_masks: [[[0, 0], [0.2, 0], [0.2, 0.2]]] },
    });
    expect(ok.json()).toMatchObject({ zones: [{ name: "front_door" }], privacy_masks: [[[0, 0], [0.2, 0], [0.2, 0.2]]] });
  });

  it("persists a brain event once, queues a signed webhook, and retries until delivered", async () => {
    const hook = await api.public.inject({ method: "POST", url: "/v1/webhooks", headers: auth(), payload: { url: "https://hooks.example.com/hook", events: ["detection.person"] } });
    expect(hook.statusCode).toBe(201);
    const { id: hookId, secret } = hook.json();
    expect(secret).toMatch(/^whsec_/);
    expect((await api.public.inject({ url: "/v1/webhooks", headers: auth() })).json().data[0].secret).toBeUndefined();

    const msg = { event_key: "ep1:person", account_id: acc, source_id: src, type: "detection.person", occurred_at: new Date().toISOString(),
      labels: ["person"], confidence: 0.87, summary: "A person at the front door.", zones: ["front_door"] };
    await handleBrainEvent(api.data, undefined, "brain.event", msg, log);
    await handleBrainEvent(api.data, undefined, "brain.event", msg, log); // redelivered: no duplicate
    const list = (await api.public.inject({ url: "/v1/events", headers: auth() })).json().data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: "detection.person", labels: ["person"], zones: ["front_door"], source: { id: src, sense: "video", location: "Front door" } });
    expect(list[0].media.clip_url).toMatch(/\/playback\/.+\/index\.m3u8$/);

    // A receiver that fails once, then accepts and checks the signature.
    const received: { sig: string; body: string }[] = [];
    let calls = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls++;
        received.push({ sig: String(req.headers["senseplane-signature"]), body });
        res.statusCode = calls === 1 ? 500 : 200;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    await api.data.withAccount(acc, (s) => s.db.updateTable("webhooks").set({ url }).where("id", "=", hookId).execute());
    const urls = { signer: createPlaybackSigner("x"), base: "http://api", ttlSeconds: 900 };
    const [d] = await api.data.withAccount(acc, (s) => s.db.selectFrom("webhook_deliveries").selectAll().execute());
    await deliverOnce(api.data, d!.id, acc, urls, log, localSender);
    let row = await api.data.withAccount(acc, (s) => s.db.selectFrom("webhook_deliveries").selectAll().where("id", "=", d!.id).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_status_code: 500 });
    expect(new Date(row.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
    await api.data.withAccount(acc, (s) => s.db.updateTable("webhook_deliveries").set({ next_attempt_at: new Date() }).where("id", "=", d!.id).execute());
    await deliverOnce(api.data, d!.id, acc, urls, log, localSender);
    row = await api.data.withAccount(acc, (s) => s.db.selectFrom("webhook_deliveries").selectAll().where("id", "=", d!.id).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ status: "delivered", attempts: 2, last_status_code: 200 });
    server.close();

    const { sig, body } = received[1]!;
    const [, t, v1] = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    expect(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")).toBe(v1);
    expect(JSON.parse(body)).toMatchObject({ type: "detection.person", summary: "A person at the front door." });

    const log2 = (await api.public.inject({ url: `/v1/webhooks/${hookId}/deliveries`, headers: auth() })).json().data;
    expect(log2[0]).toMatchObject({ status: "delivered", attempts: 2 });
    expect((await api.public.inject({ method: "POST", url: `/v1/webhooks/${hookId}/deliveries/${d!.id}/redeliver`, headers: auth() })).json().status).toBe("pending");
  });

  it("reports whether a watch event was confirmed by a model", async () => {
    const base = { account_id: acc, source_id: src, type: "watch.triggered", occurred_at: new Date().toISOString(), labels: [], confidence: null, summary: "Watch triggered." };
    await handleBrainEvent(api.data, undefined, "brain.event", { ...base, event_key: "w:unchecked", verified: false }, log);
    await handleBrainEvent(api.data, undefined, "brain.event", { ...base, event_key: "w:checked", verified: true, confidence: 0.9 }, log);
    await handleBrainEvent(api.data, undefined, "brain.event", { ...base, event_key: "p:x", type: "detection.person", verified: true }, log);
    const all = (await api.public.inject({ url: "/v1/events?limit=50", headers: auth() })).json().data as { summary: string; type: string; verified: boolean | null; confidence: number | null }[];
    const byKey = (pred: (e: (typeof all)[number]) => boolean) => all.find(pred)!;
    expect(byKey((e) => e.type === "watch.triggered" && e.confidence === null).verified).toBe(false);
    expect(byKey((e) => e.type === "watch.triggered" && e.confidence === 0.9).verified).toBe(true);
    // Only watch events carry the flag; others are null even if the brain sent one.
    expect(all.filter((e) => e.type === "detection.person").every((e) => e.verified === null)).toBe(true);
  });

  it("encrypts webhook secrets at rest and re-encrypts rows stored in plain text", async () => {
    const hook = (await api.public.inject({ method: "POST", url: "/v1/webhooks", headers: auth(), payload: { url: "https://hooks.example.com/x", events: ["detection.person"] } })).json();
    const stored = await api.data.withAccount(acc, (s) => s.db.selectFrom("webhooks").select("secret").where("id", "=", hook.id).executeTakeFirstOrThrow());
    expect(stored.secret).toMatch(/^enc:v1:/);
    expect(stored.secret).not.toContain(hook.secret);
    expect(api.data.box().decrypt(stored.secret)).toBe(hook.secret);

    // A row stored in plain text.
    await api.data.withAccount(acc, (s) => s.db.updateTable("webhooks").set({ secret: "whsec_legacy" }).where("id", "=", hook.id).execute());
    expect(await api.data.encryptLegacyWebhookSecrets()).toBe(1);
    const after = await api.data.withAccount(acc, (s) => s.db.selectFrom("webhooks").select("secret").where("id", "=", hook.id).executeTakeFirstOrThrow());
    expect(after.secret).toMatch(/^enc:v1:/);
    expect(api.data.box().decrypt(after.secret)).toBe("whsec_legacy");
    expect(await api.data.encryptLegacyWebhookSecrets()).toBe(0);
  });

  it("refuses to start in production without SECRETS_ENCRYPTION_KEY", async () => {
    const t = await createTestDatabase();
    const prev = { mode: process.env.SENSEPLANE_MODE, play: process.env.PLAYBACK_SIGNING_SECRET, key: process.env.SECRETS_ENCRYPTION_KEY, ingest: process.env.INGEST_SIGNING_KEY };
    process.env.SENSEPLANE_MODE = "production";
    process.env.PLAYBACK_SIGNING_SECRET = "p".repeat(40);
    process.env.INGEST_SIGNING_KEY = await exportPKCS8((await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true })).privateKey);
    delete process.env.SECRETS_ENCRYPTION_KEY;
    try {
      await expect(createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html" })).rejects.toThrow(/SECRETS_ENCRYPTION_KEY/);
    } finally {
      for (const [k, v] of [["SENSEPLANE_MODE", prev.mode], ["PLAYBACK_SIGNING_SECRET", prev.play], ["SECRETS_ENCRYPTION_KEY", prev.key], ["INGEST_SIGNING_KEY", prev.ingest]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await t.drop();
    }
  });

  it("stores readings and fires sensor.threshold once per crossing", async () => {
    const sensor = (await api.public.inject({ method: "POST", url: "/v1/sources", headers: auth(), payload: { name: "Server room", type: "sensor" } })).json();
    expect(sensor.senses).toEqual(["temperature", "humidity"]);
    expect(sensor.ingest.integration_token).toMatch(/^sit_/); // ADR 0045
    await api.public.inject({ method: "PATCH", url: `/v1/sources/${sensor.id}`, headers: auth(), payload: { sensor_thresholds: { temperature: { above: 28 } } } });
    const t0 = Date.now() - 60_000;
    const r = await api.public.inject({
      method: "POST", url: `/v1/sources/${sensor.id}/readings`, headers: auth(),
      payload: { readings: [26, 27, 29, 30, 27, 31].map((v, i) => ({ sense: "temperature", value: v, unit: "celsius", measured_at: new Date(t0 + i * 10_000).toISOString() })) },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json().events).toHaveLength(2); // 27→29 and 27→31; 29→30 is not a new crossing
    const events = (await api.public.inject({ url: `/v1/events?source=${sensor.id}`, headers: auth() })).json().data;
    expect(events[0]).toMatchObject({ type: "sensor.threshold", value: { sense: "temperature", value: 31, unit: "celsius" }, source: { sense: "temperature" } });
    expect((await api.public.inject({ url: `/v1/sources/${sensor.id}/history`, headers: auth() })).json().data).toHaveLength(6);
    expect((await api.public.inject({ url: `/v1/sources/${sensor.id}/now`, headers: auth() })).json().readings[0]).toMatchObject({ sense: "temperature", value: 31 });
    expect((await api.public.inject({ method: "POST", url: `/v1/sources/${sensor.id}/readings`, headers: auth(), payload: { readings: [{ sense: "temperature", value: 1, unit: "percent" }] } })).statusCode).toBe(400);
  });

  it("refuses private webhook targets in production", () => {
    expect(() => checkWebhookUrl("http://10.0.0.5/x", true)).toThrow();
    expect(() => checkWebhookUrl("https://192.168.1.2/x", true)).toThrow();
    expect(() => checkWebhookUrl("https://hooks.example.com/x", true)).not.toThrow();
    expect(() => checkWebhookUrl("http://localhost:3000/x", false)).toThrow();
    expect(() => checkWebhookUrl("http://localhost:3000/x", false, allowLocal)).not.toThrow();
    expect(() => checkWebhookUrl("https://media:8091/x", true)).toThrow();
  });
});
