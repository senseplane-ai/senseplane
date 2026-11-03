// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// MQTT out through a box (ADR 0071): off by default, turned on per box, and
// then the box long-polls the cameras, watches and new detections it publishes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEvent } from "./events.js";
import { createApi, type SenseplaneApi } from "./index.js";
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

  it("is off by default: the box publishes nothing", async () => {
    expect((await asOwner("GET", "/v1/bridges")).json().data.map((b: { mqtt_publish: boolean }) => b.mqtt_publish)).toEqual([false, false]);
    await event("detection.person");
    const r = await outputs(box.token);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ mqtt_publish: false, cursor: null, cameras: [], watches: [], events: [] });
    expect((await outputs("brg_nope")).statusCode).toBe(401);
  });

  it("only for the box it is turned on for, from now on", async () => {
    const on = await asOwner("PATCH", `/v1/bridges/${box.id}`, { mqtt_publish: true });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ id: box.id, mqtt_publish: true });
    // The first poll has no cursor: the cameras and watches, no old events.
    const first = (await outputs(box.token)).json();
    expect(first).toMatchObject({ mqtt_publish: true, cameras: [{ id: camera, name: "Front door", online: false }], watches: [], events: [] });
    expect(first.cursor).toMatch(/^evt_/);
    const person = await event("detection.person");
    await event("detection.bicycle");
    const next = (await outputs(box.token, `?after=${first.cursor}`)).json();
    expect(next.events).toEqual([{ id: person!.id, type: "detection.person", source_id: camera, occurred_at: expect.any(String), summary: "detection.person at the front door" }]);
    expect(next.cursor).toBe(person!.id);
    // The other box stays off.
    expect((await outputs(other.token, `?after=${first.cursor}`)).json().mqtt_publish).toBe(false);
  });

  it("waits for new events, and hands over watch firings", async () => {
    const start = (await outputs(box.token)).json().cursor;
    const waiting = outputs(box.token, `?after=${start}&wait=5`);
    await new Promise((r) => setTimeout(r, 300));
    await event("watch.triggered", { summary: "Someone at the door", watch_id: "wch_1" });
    const got = (await waiting).json();
    expect(got.events).toMatchObject([{ type: "watch.triggered", watch_id: "wch_1", summary: "Someone at the door" }]);
  });

  it("turned off, the box is told so", async () => {
    expect((await asOwner("PATCH", `/v1/bridges/${box.id}`, { mqtt_publish: false })).json().mqtt_publish).toBe(false);
    expect((await outputs(box.token, "?after=evt_00000000000000000000000000")).json()).toMatchObject({ mqtt_publish: false, events: [] });
    expect((await asOwner("PATCH", `/v1/bridges/${box.id}`, {})).statusCode).toBe(400);
    expect((await asOwner("PATCH", "/v1/bridges/brg_nope", { mqtt_publish: true })).statusCode).toBe(404);
  });
});
