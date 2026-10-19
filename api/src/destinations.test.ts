// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Watch destinations (ADR 0043): routing (with and without notify), validation,
// agent inboxes, schedules, several cameras per watch, and backtests.
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { candidates, moments } from "./backtest.js";
import type { EventRow } from "./events.js";
import { routeEvent } from "./events.js";
import { type ApiBus, createApi, handleBrainEvent, type SenseplaneApi } from "./index.js";
import { activeAt, localTime, scheduleProblem } from "./schedule.js";
import type { ObjectStorage } from "./storage.js";
import { createTestDatabase } from "./testdb.js";

const log = { warn() {}, error() {}, info() {} } as never;
const utc = (s: string) => new Date(`${s}Z`);

describe("routing", () => {
  const hooks = [{ id: "whk_a", events: ["watch.triggered"] }, { id: "whk_b", events: ["*"] }, { id: "whk_c", events: ["detection.person"] }];
  it("sends to every subscribed webhook without notify", () => {
    expect(routeEvent("watch.triggered", undefined, hooks)).toEqual({ webhooks: ["whk_a", "whk_b"], agents: [], channels: [] });
    expect(routeEvent("watch.triggered", [], hooks)).toEqual({ webhooks: ["whk_a", "whk_b"], agents: [], channels: [] });
  });
  it("sends only to the listed webhooks, agents and channels with notify", () => {
    const notify = [{ type: "webhook" as const, id: "whk_c" }, { type: "agent" as const, id: "agt_x" }, { type: "agent" as const, id: "agt_x" }, { type: "channel" as const, id: "chn_t" }];
    expect(routeEvent("watch.triggered", notify, hooks)).toEqual({ webhooks: ["whk_c"], agents: ["agt_x"], channels: ["chn_t"] });
    expect(routeEvent("watch.triggered", [{ type: "agent", id: "agt_x" }], hooks)).toEqual({ webhooks: [], agents: ["agt_x"], channels: [] });
    expect(routeEvent("watch.triggered", [{ type: "webhook", id: "whk_gone" }], hooks).webhooks).toEqual([]);
  });
  it("keeps subscriptions for events that aren't watch-triggered", () => {
    expect(routeEvent("detection.person", [{ type: "agent", id: "agt_x" }], hooks)).toEqual({ webhooks: ["whk_b", "whk_c"], agents: [], channels: [] });
  });
});

describe("schedules", () => {
  const night = { from: "18:00", to: "06:00", time_zone: "Europe/London" };
  it("reads local time in a zone", () => {
    expect(localTime(utc("2026-10-16T12:00:00"), "Asia/Tokyo")).toEqual({ day: 4, hhmm: "21:00" });
    expect(localTime(utc("2026-10-18T23:30:00"), "UTC")).toEqual({ day: 6, hhmm: "23:30" });
  });
  it("follows daylight saving", () => {
    expect(activeAt(utc("2026-03-29T04:30:00"), night)).toBe(true); // 05:30 BST
    expect(activeAt(utc("2026-03-29T05:30:00"), night)).toBe(false); // 06:30 BST
    expect(activeAt(utc("2026-10-24T17:30:00"), night)).toBe(true); // 18:30 BST
    expect(activeAt(utc("2026-10-25T05:30:00"), night)).toBe(true); // 05:30 GMT
    expect(activeAt(utc("2026-10-25T06:30:00"), night)).toBe(false);
    const nyRepeated = { from: "01:00", to: "02:00", time_zone: "America/New_York" };
    expect(activeAt(utc("2026-11-01T05:30:00"), nyRepeated)).toBe(true); // 01:30 EDT
    expect(activeAt(utc("2026-11-01T06:30:00"), nyRepeated)).toBe(true); // 01:30 EST
    const nySkipped = { from: "02:00", to: "03:00", time_zone: "America/New_York" };
    expect(activeAt(utc("2026-03-08T06:59:59"), nySkipped)).toBe(false);
    expect(activeAt(utc("2026-03-08T07:00:00"), nySkipped)).toBe(false);
  });
  it("gives an overnight span to the day it starts on", () => {
    const fri = { days: ["fri"], from: "18:00", to: "06:00" };
    expect(activeAt(utc("2026-10-16T19:00:00"), fri)).toBe(true);
    expect(activeAt(utc("2026-10-17T03:00:00"), fri)).toBe(true); // Saturday 03:00 is Friday's night
    expect(activeAt(utc("2026-10-16T03:00:00"), fri)).toBe(false);
    expect(activeAt(utc("2026-10-17T06:00:00"), fri)).toBe(false);
    expect(activeAt(utc("2026-10-17T19:00:00"), fri)).toBe(false);
    expect(activeAt(utc("2026-10-17T12:00:00"), { days: ["sat"], from: "00:00", to: "00:00" })).toBe(true);
  });
  it("applies the compiler's UTC hours too", () => {
    expect(activeAt(utc("2026-10-16T12:00:00"), null, [{ days: ["fri"], from: "08:00", to: "20:00" }])).toBe(true);
    expect(activeAt(utc("2026-10-16T12:00:00"), { from: "13:00", to: "14:00" }, [{ days: ["fri"], from: "08:00", to: "20:00" }])).toBe(false);
  });
  it("validates", () => {
    expect(scheduleProblem({ from: "18:00", to: "06:00", time_zone: "Europe/London" })).toBeUndefined();
    expect(scheduleProblem({ from: "24:00", to: "06:00" })).toMatch(/HH:MM/);
    expect(scheduleProblem({ from: "18:00", to: "06:00", time_zone: "Mars/Olympus" })).toMatch(/time zone/);
    expect(scheduleProblem({ from: "18:00", to: "06:00", time_zone: "+02:00" })).toMatch(/time zone/);
    expect(scheduleProblem({ days: ["fry"], from: "18:00", to: "06:00" })).toMatch(/days/);
  });
});

describe("backtest moments", () => {
  const ev = (id: string, type: string, at: string, end?: string, extra: Partial<EventRow> = {}) =>
    ({ id, type, source_id: "src", occurred_at: utc(at), ended_at: end ? utc(end) : null, zones: [], labels: [], snapshot_key: `k/${id}`, summary: id, ...extra }) as unknown as EventRow;
  const events = [
    ev("p1", "detection.person", "2026-10-16T10:00:00", "2026-10-16T10:01:00", { zones: ["front_door"] }),
    ev("v1", "detection.vehicle", "2026-10-16T10:05:00", "2026-10-16T10:05:30"),
    ev("p2", "detection.person", "2026-10-16T10:20:00", "2026-10-16T10:20:05"),
    ev("s1", "sound.detected", "2026-10-16T10:30:00", undefined, { labels: ["dog"] }),
  ];
  it("replays object, sound, sequence and sensor triggers", () => {
    expect(moments({ type: "objects", label: "person", on: "enter" }, events).map((m) => m.event!.id)).toEqual(["p1", "p2"]);
    expect(moments({ type: "objects", label: "person", on: "enter", zone: "front_door" }, events).map((m) => m.event!.id)).toEqual(["p1"]);
    expect(moments({ type: "objects", label: "person", on: "present", min_duration_s: 30 }, events).map((m) => m.event!.id)).toEqual(["p1"]);
    expect(moments({ type: "sound", class: "dog" }, events).map((m) => m.event!.id)).toEqual(["s1"]);
    const seq = moments({ type: "sequence", within_s: 600, steps: [{ type: "objects", label: "person", on: "enter" }, { type: "objects", label: "person", on: "leave" }] }, events);
    expect(seq.map((m) => new Date(m.at).toISOString())).toEqual(["2026-10-16T10:01:00.000Z", "2026-10-16T10:20:05.000Z"]);
    const readings = [24, 29, 30, 25, 31].map((v, i) => ({ sense: "temperature", value: v, unit: "celsius", measured_at: utc(`2026-10-16T10:0${i}:00`) }));
    expect(moments({ type: "sensor", sense: "temperature", above: 28 }, [], readings).map((m) => m.reading!.value)).toEqual([29, 31]);
  });
  it("applies cooldown and schedule per source", () => {
    const compiled = { trigger: { type: "objects", label: "person", on: "enter" }, cooldown_s: 3600, active_hours: null };
    const range = { from: utc("2026-10-16T00:00:00").getTime(), to: utc("2026-10-17T00:00:00").getTime() };
    const both = new Map([["a", { events }], ["b", { events: events.map((e) => ({ ...e, source_id: "b" })) }]]);
    expect(candidates(compiled, null, both, range).map((c) => c.source_id)).toEqual(["a", "b"]); // one per camera inside the cooldown
    expect(candidates({ ...compiled, cooldown_s: 0 }, { from: "10:10", to: "11:00" }, new Map([["a", { events }]]), range).map((c) => c.event!.id)).toEqual(["p2"]);
  });
});

describe("watch destinations over the API", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let owner: string;
  let acc: string;
  let front: string;
  let back: string;
  const kv = new Map<string, any>();
  const checks: string[] = [];
  const objects = new Map<string, Buffer>();
  const storage = {
    async put(key: string, body: Uint8Array) { objects.set(key, Buffer.from(body)); },
    async copy() {}, async deleteMany() { return 0; }, async deletePrefix() { return 0; }, async presign() { return undefined; },
    async get(key: string) { return { body: Readable.from([objects.get(key) ?? Buffer.alloc(0)]) }; },
  } as unknown as ObjectStorage;
  const bus: ApiBus = {
    async putSourceConfig() {},
    async latestSnapshot() { return undefined; },
    async putWatch(a, w, v) { if (v) kv.set(`${a}.${w}`, v); else kv.delete(`${a}.${w}`); },
    async close() {},
    async request<T>(subject: string, payload: any): Promise<T> {
      if (subject === "rpc.brain.compile") {
        const pkg = /package/i.test(payload.instruction);
        return {
          compiled: { trigger: { type: "objects", label: "person", on: "enter" }, cooldown_s: 0, active_hours: null, ...(pkg ? { verify: { prompt: "Is there a package?", min_confidence: 0.7 } } : {}) },
          estimate: { vlm_calls_per_day: "0" }, warnings: [], compiler: "rules", needs_zone: false,
        } as T;
      }
      if (subject === "rpc.brain.check") {
        checks.push(payload.jpeg_b64);
        const yes = Buffer.from(payload.jpeg_b64, "base64").toString() === "parcel";
        return { yes, answer: yes ? "A parcel is on the step." : "No parcel.", confidence: 0.9 } as T;
      }
      throw new Error(subject);
    },
  };
  const call = (key: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const fire = (watchId: string, sourceId: string, key: string, at = new Date()) =>
    handleBrainEvent(api.data, undefined, "brain.event", {
      event_key: key, account_id: acc, source_id: sourceId, type: "watch.triggered", watch_id: watchId, occurred_at: at.toISOString(),
      labels: [], confidence: 0.9, summary: "Watch triggered: person enter.",
    }, log);
  const deliveriesFor = (eventId: string) =>
    api.data.withAccount(acc, (s) => s.db.selectFrom("webhook_deliveries").select("webhook_id").where("event_id", "=", eventId).execute()).then((r) => r.map((x) => x.webhook_id).sort());
  const eventFor = (key: string) =>
    api.data.withAccount(acc, (s) => s.db.selectFrom("events").selectAll().where("event_key", "=", key).executeTakeFirstOrThrow());

  let hookA: string;
  let hookB: string;
  let agentX: { id: string; api_key: string };
  let agentY: { id: string; api_key: string };

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false, bus, storage,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } } });
    acc = (await api.data.accounts.create("Destinations")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    front = (await call(owner, "POST", "/v1/sources", { name: "Front door", type: "browser" })).json().id;
    back = (await call(owner, "POST", "/v1/sources", { name: "Back door", type: "browser" })).json().id;
    hookA = (await call(owner, "POST", "/v1/webhooks", { url: "https://a.example.com/h", events: ["watch.triggered"] })).json().id;
    hookB = (await call(owner, "POST", "/v1/webhooks", { url: "https://b.example.com/h", events: ["watch.triggered", "detection.person"] })).json().id;
    agentX = (await call(owner, "POST", "/v1/agents", { name: "X" })).json();
    agentY = (await call(owner, "POST", "/v1/agents", { name: "Y" })).json();
    await call(owner, "POST", "/v1/grants", { agent_id: agentX.id, source_ids: [front, back], senses: ["video"] });
    await call(owner, "POST", "/v1/grants", { agent_id: agentY.id, source_ids: [back], senses: ["video"] });
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("validates destinations and schedules", async () => {
    const bad = await call(owner, "POST", "/v1/watches", { instruction: "Someone at the door", sources: [front], notify: [{ type: "webhook", id: "whk_nope" }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.details.unknown).toEqual([{ type: "webhook", id: "whk_nope" }]);
    await call(owner, "DELETE", `/v1/agents/${agentY.id}`).then(async () => {
      // A revoked agent is not a destination.
      const r = await call(owner, "POST", "/v1/watches", { instruction: "Someone at the door", sources: [front], notify: [{ type: "agent", id: agentY.id }] });
      expect(r.statusCode).toBe(400);
    });
    expect((await call(owner, "POST", "/v1/watches", { instruction: "Someone at the door", sources: [front], notify: [{ type: "email", id: "x" }] })).statusCode).toBe(400);
    expect((await call(owner, "POST", "/v1/watches", { instruction: "Someone at the door", sources: [front], active_hours: { from: "18:00", to: "06:00", time_zone: "Nowhere/Land" } })).statusCode).toBe(400);
    // An agent key may route only to itself.
    const other = await call(agentX.api_key, "POST", "/v1/watches", { instruction: "Someone at the door", sources: [front], notify: [{ type: "webhook", id: hookA }] });
    expect(other.statusCode).toBe(403);
    const self = await call(agentX.api_key, "POST", "/v1/watches", { instruction: "Someone at the door", sources: [front], notify: [{ type: "agent", id: agentX.id }] });
    expect(self.statusCode).toBe(201);
    await call(owner, "DELETE", `/v1/watches/${self.json().id}`);
  });

  it("routes watch.triggered to notify only, and to every subscribed webhook without it", async () => {
    const routed = (await call(owner, "POST", "/v1/watches", {
      instruction: "Someone at the door", sources: [front], notify: [{ type: "webhook", id: hookA }, { type: "agent", id: agentX.id }],
    })).json();
    expect(routed.notify).toEqual([{ type: "webhook", id: hookA }, { type: "agent", id: agentX.id }]);
    expect((await call(owner, "GET", `/v1/watches/${routed.id}`)).json().notify).toHaveLength(2);
    const legacy = (await call(owner, "POST", "/v1/watches", { instruction: "Someone at the door", sources: [front] })).json();
    expect(legacy.notify).toEqual([]);
    expect(legacy.active_hours).toBeNull();

    await fire(routed.id, front, "r1");
    await fire(legacy.id, front, "l1");
    await handleBrainEvent(api.data, undefined, "brain.event", { event_key: "d1", account_id: acc, source_id: front, type: "detection.person", occurred_at: new Date().toISOString(), labels: ["person"], confidence: 0.8, summary: "A person was seen." }, log);
    expect(await deliveriesFor((await eventFor("r1")).id)).toEqual([hookA]);
    expect(await deliveriesFor((await eventFor("l1")).id)).toEqual([hookA, hookB].sort());
    expect(await deliveriesFor((await eventFor("d1")).id)).toEqual([hookB]);
    // Every event is still in the feed.
    expect((await call(owner, "GET", "/v1/events?type=watch.triggered")).json().data).toHaveLength(2);

    // PATCH replaces destinations; [] routes to every subscribed webhook again.
    const patched = await call(owner, "PATCH", `/v1/watches/${routed.id}`, { notify: [{ type: "webhook", id: hookB }] });
    expect(patched.json().notify).toEqual([{ type: "webhook", id: hookB }]);
    await fire(routed.id, front, "r2");
    expect(await deliveriesFor((await eventFor("r2")).id)).toEqual([hookB]);
    await call(owner, "PATCH", `/v1/watches/${routed.id}`, { notify: [{ type: "agent", id: agentX.id }] });
  });

  it("queues agent events in its inbox, filtered by grants, until seen", async () => {
    const r = (await call(agentX.api_key, "GET", "/v1/inbox?unseen=true")).json();
    expect(r.agent_id).toBe(agentX.id);
    expect(r.data).toHaveLength(1);
    expect(r.data[0]).toMatchObject({ seen_at: null, event: { type: "watch.triggered", source: { id: front, name: "Front door" } } });
    // Account keys name the agent; agent keys can't read another inbox.
    expect((await call(owner, "GET", "/v1/inbox")).statusCode).toBe(400);
    expect((await call(owner, "GET", `/v1/inbox?agent=${agentX.id}`)).json().data).toHaveLength(1);
    expect((await call(agentX.api_key, "GET", `/v1/inbox?agent=${agentY.id}`)).statusCode).toBe(403);
    expect((await call(agentX.api_key, "POST", "/v1/inbox/seen", { ids: [r.data[0].id] })).json()).toEqual({ marked: 1 });
    expect((await call(agentX.api_key, "GET", "/v1/inbox?unseen=true")).json().data).toHaveLength(0);
    expect((await call(agentX.api_key, "GET", "/v1/inbox")).json().data[0].seen_at).toBeTruthy();

    // A grant that no longer covers the source hides the item.
    const watch = (await call(owner, "POST", "/v1/watches", { instruction: "Someone at the door", sources: [front], notify: [{ type: "agent", id: agentX.id }] })).json();
    await fire(watch.id, front, "g1");
    expect((await call(agentX.api_key, "GET", "/v1/inbox?unseen=true")).json().data).toHaveLength(1);
    const grants = (await call(owner, "GET", "/v1/grants")).json().data.filter((g: any) => g.agent_id === agentX.id);
    for (const g of grants) await call(owner, "DELETE", `/v1/grants/${g.id}`);
    expect((await call(agentX.api_key, "GET", "/v1/inbox?unseen=true")).json().data).toHaveLength(0);
    await call(owner, "POST", "/v1/grants", { agent_id: agentX.id, source_ids: [front, back], senses: ["video"] });
    await call(agentX.api_key, "POST", "/v1/inbox/seen", { all: true });
  });

  it("watches several cameras by name, naming the camera in events", async () => {
    const w = (await call(owner, "POST", "/v1/watches", {
      instruction: "Someone at a door", sources: ["front door", "Back door", front], active_hours: { from: "18:00", to: "06:00", time_zone: "Europe/London" },
    })).json();
    expect(w.sources).toEqual([front, back]);
    expect(w.active_hours).toEqual({ from: "18:00", to: "06:00", time_zone: "Europe/London" });
    expect(kv.get(`${acc}.${w.id}`)).toMatchObject({ sources: [front, back], active_hours: { time_zone: "Europe/London" } });
    expect((await call(owner, "POST", "/v1/watches", { instruction: "Someone", sources: ["Garage"] })).statusCode).toBe(404);
    await fire(w.id, back, "m1");
    await fire(w.id, front, "m2");
    const events = (await call(owner, "GET", "/v1/events?type=watch.triggered")).json().data.filter((e: any) => e.watch_id === w.id);
    expect(events.map((e: any) => e.summary).sort()).toEqual(["Back door: Watch triggered: person enter.", "Front door: Watch triggered: person enter."]);
    expect(events.map((e: any) => e.source.name).sort()).toEqual(["Back door", "Front door"]);
    expect((await call(owner, "PATCH", `/v1/watches/${w.id}`, { active_hours: null })).json().active_hours).toBeNull();
    await call(owner, "DELETE", `/v1/watches/${w.id}`);
  });

  it("applies the schedule to sensor watches", async () => {
    const sensor = (await call(owner, "POST", "/v1/sources", { name: "Server room", type: "sensor" })).json();
    bus.request = (async (subject: string, payload: any) => subject === "rpc.brain.compile"
      ? { compiled: { trigger: { type: "sensor", sense: "temperature", above: 27 }, cooldown_s: 0, active_hours: null }, estimate: { vlm_calls_per_day: "0" }, warnings: [], compiler: "rules", needs_zone: false }
      : origRequest(subject, payload)) as ApiBus["request"];
    const w = (await call(owner, "POST", "/v1/watches", { instruction: "Warn me if the server room gets hot", sources: [sensor.id], active_hours: { from: "09:00", to: "17:00" } })).json();
    bus.request = origRequest;
    const day = (h: number) => new Date(Date.UTC(2026, 9, 15, h)).toISOString();
    await call(owner, "POST", `/v1/sources/${sensor.id}/readings`, { readings: [
      { sense: "temperature", value: 30, unit: "celsius", measured_at: day(3) }, // night: off
      { sense: "temperature", value: 20, unit: "celsius", measured_at: day(4) },
      { sense: "temperature", value: 30, unit: "celsius", measured_at: day(10) }, // working hours: on
    ] });
    const fired = (await call(owner, "GET", `/v1/events?source=${sensor.id}&type=reading.threshold`)).json().data;
    expect(fired.map((e: any) => e.occurred_at)).toEqual([new Date(day(10)).toISOString()]);
    expect(fired[0].watch_id).toBe(w.id);
  });
  const origRequest = bus.request;

  it("backtests over stored detections with a capped number of model checks", async () => {
    const t0 = Date.now() - 50 * 60_000;
    const detection = async (key: string, minutes: number, jpeg: string, source = front) => {
      await handleBrainEvent(api.data, storage, "brain.event", {
        event_key: key, account_id: acc, source_id: source, type: "detection.person", occurred_at: new Date(t0 + minutes * 60_000).toISOString(),
        labels: ["person"], confidence: 0.8, summary: "A person was seen.", snapshot_jpeg_b64: Buffer.from(jpeg).toString("base64"),
      }, log);
    };
    await detection("bt1", 1, "nothing");
    await detection("bt2", 5, "parcel");
    await detection("bt3", 9, "parcel", back);
    await detection("bt4", 12, "parcel");
    const range = { from: new Date(t0).toISOString(), to: new Date().toISOString() };
    const r = await call(owner, "POST", "/v1/watches/test", { instruction: "Tell me if a package is left", sources: ["Front door", "Back door"], ...range, max_checks: 3 });
    expect(r.statusCode).toBe(200);
    const out = r.json();
    expect(out.checks_used).toBe(3);
    expect(checks).toHaveLength(3);
    // d1 (front, includes the earlier test's detection) is an hour+ older; the 3 checked are the first three in the range.
    expect(out.candidates).toBeGreaterThanOrEqual(4);
    expect(out.unchecked).toBe(out.candidates - 3);
    expect(out.matches.map((m: any) => m.source_name)).toEqual(expect.arrayContaining(["Back door"]));
    for (const m of out.matches) {
      expect(m).toMatchObject({ verified: true, summary: "A parcel is on the step." });
      expect(m.snapshot_url).toMatch(/\/media\/.+\/snapshot\.jpg$/);
    }
    // Without a check, every candidate is a match and no AI checks are used.
    const plain = (await call(owner, "POST", "/v1/watches/test", { instruction: "Someone at the door", sources: [back], ...range })).json();
    expect(plain).toMatchObject({ checks_used: 0, matches: [{ source_id: back, source_name: "Back door", verified: null }] });
    // Agents need to see the sources; bad ranges are refused.
    expect((await call(owner, "POST", "/v1/watches/test", { instruction: "Someone", sources: [front], from: range.to, to: range.from })).statusCode).toBe(400);
    expect((await call(agentX.api_key, "POST", "/v1/watches/test", { instruction: "Someone at the door", sources: [front], ...range })).statusCode).toBe(200);

    // Checking history for a tracking watch keeps what it finds as the watch's activities (ADR 0057).
    const track = (await call(owner, "POST", "/v1/watches", { instruction: "Track when a package is left", sources: [front, back], mode: "track" })).json();
    const checked = (await call(owner, "POST", "/v1/activity/check", { watch_id: track.id, ...range, max_checks: 10 })).json();
    expect(checked.stored).toBe(checked.matches.length);
    expect(checked.stored).toBeGreaterThanOrEqual(3);
    const counted = (await call(owner, "POST", "/v1/activity/query", { measure: "count", what: { watch_id: track.id }, from: range.from })).json();
    expect(counted.value).toBe(checked.stored);
    const list = (await call(owner, "GET", `/v1/activities?kind=watch&label=${track.id}&from=${range.from}`)).json().data;
    expect(list.every((x: { checked: boolean; verified: boolean }) => x.checked && x.verified)).toBe(true);
    // Run again: the same moments, not counted twice.
    await call(owner, "POST", "/v1/activity/check", { watch_id: track.id, ...range, max_checks: 10 });
    expect((await call(owner, "POST", "/v1/activity/query", { measure: "count", what: { watch_id: track.id }, from: range.from })).json().value).toBe(checked.stored);
    expect((await call(owner, "POST", "/v1/activity/check", { ...range })).statusCode).toBe(400);
  });
});
