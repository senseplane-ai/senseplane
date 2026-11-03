// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// MQTT out through a box (ADR 0071): off by default, turned on per box, and
// then the box long-polls the cameras, watches and new detections it publishes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulid } from "./data/ids.js";
import { createEvent } from "./events.js";
import { createApi, type SenseplaneApi } from "./index.js";
import { idAt, timeOf } from "./routes/bridge-outputs.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

describe("bridge outputs (MQTT out)", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let owner: string;
  let acc: string;
  let camera: string;
  let box: { id: string; token: string };
  let other: { id: string; token: string };
  const asOwner = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${owner}` } });
  const outputs = (token: string, query = "") => api.public.inject({ method: "GET", url: `/v1/bridge/outputs${query}`, headers: { authorization: `Bearer ${token}` } });
  let n = 0;
  const event = (type: string, extra: Record<string, unknown> = {}) => api.data.withAccount(acc, (s) => createEvent(s, {
    event_key: `k${n++}`, source_id: camera, type, sense: "video", occurred_at: new Date(), summary: `${type} at the front door`, labels: ["person"], confidence: 0.9, ...extra,
  }));
  /** An event stored with a chosen id, as one whose transaction commits late would appear. */
  const eventWithId = (id: string, type = "detection.person", occurredAt = new Date()) => api.data.withAccount(acc, (s) => s.db.insertInto("events").values({
    id, account_id: acc, source_id: camera, event_key: `k${n++}`, type, sense: "video", occurred_at: occurredAt, summary: "late", labels: [], zones: [], confidence: null,
  }).execute());
  const watch = (id: string, mode: string) => api.data.withAccount(acc, (s) => s.db.insertInto("watches").values({
    id, account_id: acc, instruction: `watch ${id}`, sources: [camera], mode,
    compiled: JSON.stringify({ trigger: { type: "label", label: "person" }, cooldown_s: 0, active_hours: null }), estimate: JSON.stringify({}), status: "active",
  }).execute());

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    const plane = fakeMediaPlane();
    api = await createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", media: { control: plane.client, publicUrl: "https://media.test" } });
    acc = (await api.data.accounts.create("A")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    camera = (await api.data.withAccount(acc, (s) => s.sources.create({ name: "Front door", type: "browser" }))).id;
    box = (await asOwner("POST", "/v1/bridges", { name: "Home Assistant" })).json();
    other = (await asOwner("POST", "/v1/bridges", { name: "Shed" })).json();
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("an account with no events still gets a cursor: now", async () => {
    const off = (await outputs(box.token)).json();
    expect(off).toMatchObject({ mqtt_publish: false, bridge_id: box.id, cameras: [], watches: [], events: [] });
    expect(timeOf(off.cursor)).toBeGreaterThan(Date.now() - 5_000);
    await asOwner("PATCH", `/v1/bridges/${box.id}`, { mqtt_publish: true });
    const on = (await outputs(box.token)).json();
    expect(on.events).toEqual([]);
    expect(timeOf(on.cursor)).toBeGreaterThan(Date.now() - 5_000);
    // With that cursor the next poll waits; it doesn't answer at once.
    const started = Date.now();
    const next = (await outputs(box.token, `?after=${on.cursor}&wait=1`)).json();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(next.cursor >= on.cursor).toBe(true);
    await asOwner("PATCH", `/v1/bridges/${box.id}`, { mqtt_publish: false });
  });

  it("is off by default: the box publishes nothing", async () => {
    expect((await asOwner("GET", "/v1/bridges")).json().data.map((b: { mqtt_publish: boolean }) => b.mqtt_publish)).toEqual([false, false]);
    await event("detection.person");
    const r = await outputs(box.token);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ mqtt_publish: false, cameras: [], watches: [], events: [] });
    expect((await outputs("brg_nope")).statusCode).toBe(401);
  });

  it("only for the box it is turned on for, from now on, with each event's age by the server's clock", async () => {
    const on = await asOwner("PATCH", `/v1/bridges/${box.id}`, { mqtt_publish: true });
    expect(on.json()).toMatchObject({ id: box.id, mqtt_publish: true });
    const first = (await outputs(box.token)).json();
    expect(first).toMatchObject({ mqtt_publish: true, cameras: [{ id: camera, name: "Front door", online: false }], watches: [], events: [] });
    const person = await event("detection.person");
    await event("detection.bicycle");
    const next = (await outputs(box.token, `?after=${first.cursor}`)).json();
    // A little before the cursor is read again (the box drops what it had): only what is newer here.
    expect(next.events.filter((e: { id: string }) => e.id > first.cursor)).toEqual([{ id: person!.id, type: "detection.person", source_id: camera, occurred_at: expect.any(String), age_ms: expect.any(Number), summary: "detection.person at the front door" }]);
    expect(next.events[0].age_ms).toBeLessThan(5_000);
    expect(typeof next.now).toBe("string");
    expect(next.cursor >= person!.id).toBe(true);
    expect((await outputs(other.token, `?after=${first.cursor}`)).json().mqtt_publish).toBe(false);
  });

  it("is woken at once by a new event, not on its next look", async () => {
    const start = (await outputs(box.token)).json().cursor;
    const started = Date.now();
    const waiting = outputs(box.token, `?after=${start}&wait=20`);
    await new Promise((r) => setTimeout(r, 300));
    await event("detection.animal");
    const got = (await waiting).json();
    expect(got.events.filter((e: { id: string }) => e.id > start).map((e: { type: string }) => e.type)).toEqual(["detection.animal"]);
    expect(Date.now() - started).toBeLessThan(3_000); // the fallback look is every 5 s
  });

  it("an event whose id is below the cursor but stored later still arrives; one older than the overlap doesn't", async () => {
    const cursor = (await outputs(box.token)).json().cursor;
    const late = `evt_${ulid(timeOf(cursor)! - 2_000)}`;
    const stale = `evt_${ulid(timeOf(cursor)! - 30_000)}`;
    await eventWithId(late);
    await eventWithId(stale);
    const got = (await outputs(box.token, `?after=${cursor}&wait=0`)).json();
    const ids = got.events.map((e: { id: string }) => e.id);
    expect(ids).toContain(late);
    expect(ids).not.toContain(stale);
  });

  it("never reaches further back than ten minutes, however old the cursor", async () => {
    const old = `evt_${ulid(Date.now() - 30 * 60_000)}`;
    await eventWithId(old, "detection.person", new Date(Date.now() - 30 * 60_000));
    const got = (await outputs(box.token, `?after=${idAt(Date.now() - 3_600_000)}&wait=0`)).json();
    expect(got.events.map((e: { id: string }) => e.id)).not.toContain(old);
  });

  it("hands over firings of alerting watches only", async () => {
    await watch("wat_alert", "alert");
    await watch("wat_track", "track");
    const start = (await outputs(box.token)).json();
    expect(start.watches.map((w: { id: string }) => w.id)).toEqual(["wat_alert"]);
    await event("watch.triggered", { summary: "Tracked", watch_id: "wat_track" });
    await event("watch.triggered", { summary: "Someone at the door", watch_id: "wat_alert" });
    const got = (await outputs(box.token, `?after=${start.cursor}&wait=0`)).json();
    expect(got.events.filter((e: { type: string }) => e.type === "watch.triggered")).toMatchObject([{ watch_id: "wat_alert", summary: "Someone at the door" }]);
  });

  it("off, a poll waits, and is woken when publishing is turned on", async () => {
    const started = Date.now();
    const waiting = outputs(other.token, "?wait=20");
    await new Promise((r) => setTimeout(r, 500));
    await asOwner("PATCH", `/v1/bridges/${other.id}`, { mqtt_publish: true });
    expect((await waiting).json()).toMatchObject({ mqtt_publish: true, bridge_id: other.id });
    expect(Date.now() - started).toBeLessThan(3_000);
    await asOwner("PATCH", `/v1/bridges/${other.id}`, { mqtt_publish: false });
  });

  it("turned off, the box is told so", async () => {
    expect((await asOwner("PATCH", `/v1/bridges/${box.id}`, { mqtt_publish: false })).json().mqtt_publish).toBe(false);
    expect((await outputs(box.token, `?after=${idAt(Date.now())}`)).json()).toMatchObject({ mqtt_publish: false, events: [] });
    expect((await asOwner("PATCH", `/v1/bridges/${box.id}`, {})).statusCode).toBe(400);
    expect((await asOwner("PATCH", "/v1/bridges/brg_nope", { mqtt_publish: true })).statusCode).toBe(404);
  });

  it("a box reading sensors only over MQTT has them online while its broker is reachable", async () => {
    const cfg = (await outputs(box.token)).statusCode && (await api.public.inject({ method: "GET", url: "/v1/bridge/config", headers: { authorization: `Bearer ${box.token}` } })).json();
    expect(cfg.features).toContain("health_mqtt");
    const sensor = await api.data.withAccount(acc, async (s) => {
      const src = await s.sources.create({ name: "Garage sensors", type: "sensor", senses: ["temperature"] });
      await s.db.updateTable("sources").set({ bridge_id: box.id }).where("id", "=", src.id).execute();
      return src.id;
    });
    const health = (mqtt: { connected: boolean }) => api.public.inject({ method: "POST", url: "/v1/bridge/health", payload: { cameras: [], mqtt }, headers: { authorization: `Bearer ${box.token}` } });
    expect((await health({ connected: true })).statusCode).toBe(204);
    expect((await asOwner("GET", `/v1/sources/${sensor}`)).json().status).toBe("online");
    await health({ connected: false });
    expect((await asOwner("GET", `/v1/sources/${sensor}`)).json()).toMatchObject({ status: "offline" });
  });
});
