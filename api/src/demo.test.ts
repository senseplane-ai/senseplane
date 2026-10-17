// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiBus, createApi, demoConfig, handleBrainEvent, type SenseplaneApi, sweepDemos } from "./index.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

const log = { warn() {}, error() {}, info() {} } as never;

describe("live demo API", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let base: string;
  const kv = new Map<string, unknown>();
  const plane = fakeMediaPlane();
  const bus: ApiBus = {
    async putSourceConfig() {},
    async latestSnapshot() { return undefined; },
    async putWatch(a, w, v) { if (v) kv.set(`${a}.${w}`, v); else kv.delete(`${a}.${w}`); },
    async close() {},
    async request<T>(subject: string): Promise<T> {
      if (subject === "rpc.brain.embed") return { vectors: [[1, ...new Array(383).fill(0)]] } as T;
      if (subject === "rpc.brain.ask") return { answer: "A person is holding a box at the door.", confidence: 0.9 } as T;
      throw new Error(subject);
    },
  };

  beforeAll(async () => {
    process.env.DEMO_SESSIONS_PER_IP_DAY = "2";
    process.env.TRUSTED_PROXIES = "127.0.0.1"; // the test acts as the reverse proxy for the burst test
    process.env.DEMO_CAPTURE_URL = "http://127.0.0.1:3002/try";
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false, bus,
      media: { control: plane.client },
    });
    await api.public.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(api.public.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
    delete process.env.DEMO_SESSIONS_PER_IP_DAY;
    delete process.env.TRUSTED_PROXIES;
  });

  it("starts a session with a capture link, QR and two preset watches, and limits sessions per IP", async () => {
    const r = await fetch(`${base}/v1/demo/sessions`, { method: "POST", headers: { origin: "http://127.0.0.1:3002" } });
    expect(r.status).toBe(201);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3002");
    const s = await r.json();
    expect(s.id).toMatch(/^dem_/);
    expect(s.capture_url).toMatch(/^http:\/\/127\.0\.0\.1:3002\/try#t=/);
    expect(s.qr_svg).toContain("<svg");
    expect(s.watches.map((w: { instruction: string }) => w.instruction)).toEqual(["Tell me if a package is left at the door", "Tell me when someone comes to the door"]);
    expect(s.limits).toEqual({ max_minutes: 10, vlm_calls: 20, delete_after_minutes: 60 });
    expect([...kv.keys()].filter((k) => k.startsWith(s.watches[0].id) || k.endsWith(s.watches[0].id))).toHaveLength(1);
    // The capture ticket works with the capture-join endpoint (video only).
    const ticket = new URLSearchParams(new URL(s.capture_url).hash.slice(1)).get("t");
    expect((await fetch(`${base}/v1/capture/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) })).status).toBe(200);

    expect((await fetch(`${base}/v1/demo/sessions`, { method: "POST" })).status).toBe(201);
    const third = await fetch(`${base}/v1/demo/sessions`, { method: "POST" });
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe("rate_limited");
  });

  it("holds the per-IP limit under a concurrent burst", async () => {
    const burst = await Promise.all(Array.from({ length: 6 }, () =>
      fetch(`${base}/v1/demo/sessions`, { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" } }).then((r) => r.status)));
    expect(burst.filter((s) => s === 201)).toHaveLength(2);
    expect(burst.filter((s) => s === 429)).toHaveLength(4);
  });

  it("only lets the website origins call it from a browser", async () => {
    const ok = await fetch(`${base}/v1/demo/sessions`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:3002", "access-control-request-method": "POST" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3002");
    const del = await fetch(`${base}/v1/demo/sessions/dem_x`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:3002", "access-control-request-method": "DELETE" } });
    expect(del.headers.get("access-control-allow-methods")).toContain("DELETE");
    const evil = await fetch(`${base}/v1/demo/sessions`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("streams events over SSE, answers from memory and live, then ends and deletes everything", async () => {
    await api.data.db().deleteFrom("demo_sessions").execute(); // fresh IP allowance
    const s = await (await fetch(`${base}/v1/demo/sessions`, { method: "POST" })).json();
    const auth = { authorization: `Bearer ${s.token}`, "content-type": "application/json" };
    expect((await fetch(`${base}/v1/demo/sessions/${s.id}/events`)).status).toBe(401);

    const row = await api.data.demoSessions.selectAll().where("id", "=", s.id).executeTakeFirstOrThrow();
    const acc = row.account_id!;
    // Before anything happens, memory says so.
    const empty = await (await fetch(`${base}/v1/demo/sessions/${s.id}/ask`, { method: "POST", headers: auth, body: JSON.stringify({ question: "When did the courier come?" }) })).json();
    expect(empty).toMatchObject({ from: "memory", answer: "Nothing has happened in front of the camera yet." });

    const ctrl = new AbortController();
    const res = await fetch(`${base}/v1/demo/sessions/${s.id}/events`, { headers: auth, signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    let text = "";
    const until = async (needle: string) => {
      while (!text.includes(needle)) text += new TextDecoder().decode((await reader.read()).value);
    };
    await until("event: status");
    await handleBrainEvent(api.data, undefined, "brain.event", {
      event_key: "k1", account_id: acc, source_id: s.source_id, type: "watch.triggered", watch_id: s.watches[0].id,
      occurred_at: new Date().toISOString(), labels: [], confidence: 0.9, summary: "A small cardboard package sits on the doorstep.",
    }, log, async () => [[1, ...new Array(383).fill(0)]]);
    await until("A small cardboard package");
    ctrl.abort();

    const mem = await (await fetch(`${base}/v1/demo/sessions/${s.id}/ask`, { method: "POST", headers: auth, body: JSON.stringify({ question: "When did the courier come?" }) })).json();
    expect(mem).toMatchObject({ from: "memory", answer: "A small cardboard package sits on the doorstep.", event: { type: "watch.triggered" } });
    const liveAns = await (await fetch(`${base}/v1/demo/sessions/${s.id}/ask`, { method: "POST", headers: auth, body: JSON.stringify({ question: "What do you see?" }) })).json();
    expect(liveAns).toMatchObject({ from: "live", answer: "A person is holding a box at the door." });

    expect((await fetch(`${base}/v1/demo/sessions/${s.id}`, { method: "DELETE", headers: { authorization: auth.authorization } })).status).toBe(204);
    expect(plane.removed.map((r) => r.room)).toContain(`sp-${s.source_id}`);
    expect([...kv.keys()].some((k) => k.startsWith(acc))).toBe(false); // watches stopped
    // An hour later (simulated), the sweeper deletes the account and everything under it.
    await api.data.db().updateTable("demo_sessions").set({ purge_after: new Date(Date.now() - 1000) }).where("id", "=", s.id).execute();
    const swept = await sweepDemos({ data: api.data, bus }, demoConfig());
    expect(swept.purged).toBe(1);
    expect(await api.data.withAccount(acc, (a) => a.db.selectFrom("events").selectAll().execute())).toEqual([]);
    expect(await api.data.withAccount(acc, (a) => a.db.selectFrom("accounts").selectAll().execute())).toEqual([]);
    expect((await fetch(`${base}/v1/demo/sessions/${s.id}/ask`, { method: "POST", headers: auth, body: JSON.stringify({ question: "Hello?" }) })).status).toBe(401);
  });
});
