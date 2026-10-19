// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiBus, createApi, handleBrainEvent, type SenseplaneApi } from "./index.js";
import { expireWatches } from "./routes/watches.js";
import { createTestDatabase } from "./testdb.js";

const log = { warn() {}, error() {}, info() {} } as never;

/** Deterministic 384-d "embedding": bag of hashed words, normalised. */
function fakeEmbed(text: string): number[] {
  const v = new Array(384).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const syn = { courier: "package", parcel: "package", delivery: "package", box: "package" }[w] ?? w;
    let h = 0;
    for (const c of syn) h = (h * 31 + c.charCodeAt(0)) % 384;
    v[h] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

describe("watches, ask, memory search, sensor watches", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let key: string;
  let acc: string;
  let src: string;
  const kv = new Map<string, unknown>();
  const requests: { subject: string; payload: any }[] = [];
  const bus: ApiBus = {
    async putSourceConfig() {},
    async latestSnapshot() { return undefined; },
    async putWatch(a, w, value) { if (value) kv.set(`${a}.${w}`, value); else kv.delete(`${a}.${w}`); },
    async close() {},
    async request<T>(subject: string, payload: any): Promise<T> {
      requests.push({ subject, payload });
      if (subject === "rpc.brain.compile") {
        const pkg = /package/i.test(payload.instruction);
        return {
          compiled: pkg
            ? { trigger: { type: "sequence", within_s: 600, steps: [{ type: "objects", label: "person", on: "enter", zone: "front_door" }, { type: "objects", label: "person", on: "leave", zone: "front_door" }] },
                verify: { prompt: "Is there a package left on the doorstep?", min_confidence: 0.7 }, cooldown_s: 600, active_hours: null }
            : { trigger: { type: "sensor", sense: "temperature", above: 28 }, cooldown_s: 600, active_hours: null },
          estimate: { vlm_calls_per_day: pkg ? "1–10" : "0" }, warnings: [], compiler: "llm", needs_zone: false,
        } as T;
      }
      if (subject === "rpc.brain.embed") return { vectors: payload.texts.map(fakeEmbed) } as T;
      if (subject === "rpc.brain.ask") return { answer: "The stove is off.", yes: false, confidence: 0.9 } as T;
      throw new Error("unexpected " + subject);
    },
  };

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false, bus,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } } });
    acc = (await api.data.accounts.create("Watches")).id;
    key = (await api.data.withAccount(acc, (s) => s.apiKeys.create("t"))).key;
    src = (await api.public.inject({ method: "POST", url: "/v1/sources", headers: { authorization: `Bearer ${key}` }, payload: { name: "Door", type: "browser" } })).json().id;
    await api.public.inject({ method: "PATCH", url: `/v1/sources/${src}`, headers: { authorization: `Bearer ${key}` }, payload: { zones: [{ name: "front_door", polygon: [[0, 0], [1, 0], [1, 1]] }] } });
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });

  it("creates a watch, compiled once by the brain, and shares it through KV", async () => {
    const r = await call("POST", "/v1/watches", { instruction: "Tell me if a package is left at the front door", sources: [src] });
    expect(r.statusCode).toBe(201);
    const w = r.json();
    expect(w).toMatchObject({ mode: "alert", status: "active", compiled: { trigger: { type: "sequence" }, verify: { min_confidence: 0.7 } } });
    expect(requests.find((x) => x.subject === "rpc.brain.compile")!.payload).toMatchObject({ zones: ["front_door"], senses: ["video"] });
    expect(kv.get(`${acc}.${w.id}`)).toMatchObject({ id: w.id, sources: [src], status: "active" });

    const bad = await call("PATCH", `/v1/watches/${w.id}`, { compiled: { trigger: { type: "teleport" }, cooldown_s: 1, active_hours: null } });
    expect(bad.json().error.code).toBe("validation_failed");
    const edited = await call("PATCH", `/v1/watches/${w.id}`, { compiled: { ...w.compiled, cooldown_s: 120 }, status: "paused" });
    expect(edited.json()).toMatchObject({ status: "paused", compiled: { cooldown_s: 120 } });
    expect(kv.get(`${acc}.${w.id}`)).toMatchObject({ status: "paused" });
    expect((await call("GET", "/v1/watches")).json().data).toHaveLength(1);
    expect((await call("POST", "/v1/watches", { instruction: "Tell me", sources: ["src_nope"] })).statusCode).toBe(404);
  });

  it("makes tracking watches (ADR 0057) and switches a watch between alert and track", async () => {
    const w = (await call("POST", "/v1/watches", { instruction: "Track when someone eats at the table", sources: [src], mode: "track" })).json();
    expect(w.mode).toBe("track");
    expect(kv.get(`${acc}.${w.id}`)).toMatchObject({ mode: "track" });
    const alert = (await call("PATCH", `/v1/watches/${w.id}`, { mode: "alert" })).json();
    expect(alert.mode).toBe("alert");
    expect(kv.get(`${acc}.${w.id}`)).toMatchObject({ mode: "alert" });
    expect((await call("POST", "/v1/watches", { instruction: "Track meals", sources: [src], mode: "count" })).statusCode).toBe(400);
    await call("DELETE", `/v1/watches/${w.id}`);
  });

  it("puts a camera at a site", async () => {
    const s = (await call("POST", "/v1/sources", { name: "Till", type: "browser", site: "High St" })).json();
    expect(s.site).toBe("High St");
    expect((await call("PATCH", `/v1/sources/${s.id}`, { site: "Market Sq" })).json().site).toBe("Market Sq");
    expect((await call("PATCH", `/v1/sources/${s.id}`, { site: null })).json().site).toBeNull();
  });

  it("answers ask from the brain", async () => {
    const r = await call("POST", `/v1/sources/${src}/ask`, { question: "Is the stove on?" });
    expect(r.json()).toMatchObject({ answer: "The stove is off.", yes: false, confidence: 0.9 });
  });

  it("finds the courier in memory", async () => {
    const watch = (await call("GET", "/v1/watches")).json().data[0];
    const now = Date.now();
    const events = [
      { key: "e1", type: "watch.triggered", summary: "A small cardboard package sits on the ground next to the front door.", labels: [], watch_id: watch.id },
      { key: "e2", type: "detection.vehicle", summary: "A vehicle was seen.", labels: ["vehicle"] },
      { key: "e3", type: "detection.animal", summary: "An animal was seen.", labels: ["animal"] },
      { key: "e4", type: "sound.detected", summary: "Heard crying.", labels: ["crying"] },
    ];
    for (const [i, e] of events.entries()) {
      await handleBrainEvent(api.data, undefined, "brain.event", {
        event_key: e.key, account_id: acc, source_id: src, type: e.type, occurred_at: new Date(now - (i + 1) * 3600_000).toISOString(),
        labels: e.labels, confidence: 0.9, summary: e.summary, ...(e.watch_id ? { watch_id: e.watch_id } : {}),
      }, log, async (texts) => texts.map(fakeEmbed));
    }
    const r = await call("GET", `/v1/memory/search?q=${encodeURIComponent("when did the courier come?")}`);
    const hits = r.json().data;
    expect(hits[0].event.summary).toContain("package");
    expect(hits[0].event.watch_id).toBe(watch.id);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("fires a sensor watch once per out-of-range run", async () => {
    const sensor = (await call("POST", "/v1/sources", { name: "Server room", type: "sensor" })).json();
    const w = (await call("POST", "/v1/watches", { instruction: "Tell me if the temperature is above 28", sources: [sensor.id] })).json();
    const t0 = Date.now() - 60_000;
    const r = await call("POST", `/v1/sources/${sensor.id}/readings`, {
      readings: [25, 29, 30, 26, 31].map((v, i) => ({ sense: "temperature", value: v, unit: "celsius", measured_at: new Date(t0 + i * 10_000).toISOString() })),
    });
    const events = (await call("GET", `/v1/events?source=${sensor.id}&type=reading.threshold`)).json().data;
    expect(events).toHaveLength(2); // 29–30 is one run, 31 is a second
    expect(events[0]).toMatchObject({ watch_id: w.id, value: { value: 31 } });
    expect(r.statusCode).toBe(202);
  });
  it("stops a watch when its duration is up", async () => {
    const w = (await call("POST", "/v1/watches", { instruction: "Tell me when someone comes to the door", sources: [src], duration_minutes: 5 })).json();
    expect(Date.parse(w.expires_at) - Date.now()).toBeGreaterThan(4 * 60_000);
    await api.data.withAccount(acc, (s) => s.db.updateTable("watches").set({ expires_at: new Date(Date.now() - 1000) }).where("id", "=", w.id).execute());
    expect(await expireWatches(api.data, bus)).toBeGreaterThanOrEqual(1);
    expect((await call("GET", `/v1/watches/${w.id}`)).json().status).toBe("expired");
    expect(kv.has(`${acc}.${w.id}`)).toBe(false);
    await call("DELETE", `/v1/watches/${w.id}`);
  });
});
