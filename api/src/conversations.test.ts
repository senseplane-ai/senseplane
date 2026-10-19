// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Ask (ADR 0041): conversations, the brain's tool loop over the bus (faked
// here), streamed and JSON answers, moments signed per caller, and grants.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiBus, type BrainStreamHandlers, createApi, handleBrainEvent, type SenseplaneApi } from "./index.js";
import type { ObjectStorage } from "./storage.js";
import { createTestDatabase } from "./testdb.js";
import { storeActivity } from "./brain-events.js";

const log = { warn() {}, error() {}, info() {} } as never;
const vec = (hot: number) => [...new Array(384).fill(0).map((_, i) => (i === hot ? 1 : 0))];

type Script = (payload: Record<string, any>, on: BrainStreamHandlers) => Promise<void>;

describe("conversations", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let base: string;
  let owner: string;
  let acc: string;
  let door: string;
  let yard: string;
  let doorEvent: string;
  let yardEvent: string;
  const objects = new Map<string, Uint8Array>();
  const streams: { payload: Record<string, any>; tools: { name: string; args: any; out: any }[] }[] = [];
  let script: Script;

  const storage: ObjectStorage = {
    async put(key, body) { objects.set(key, body); },
    async copy() {},
    async deleteMany(keys) { keys.forEach((k) => objects.delete(k)); return keys.length; },
    async deletePrefix() { return 0; },
    async presign() { return undefined; },
    async get(key) {
      const body = objects.get(key);
      if (!body) throw new Error("no such key");
      return { body: (async function* () { yield body; })() } as never;
    },
  };
  const bus: ApiBus = {
    async putSourceConfig() {},
    async putWatch() {},
    async latestSnapshot() { return undefined; },
    async close() {},
    async request<T>(subject: string): Promise<T> {
      if (subject === "rpc.brain.embed") return { vectors: [vec(1)] } as T;
      throw new Error(subject);
    },
    async stream(_subject, payload, on) {
      const rec = { payload, tools: [] as { name: string; args: any; out: any }[] };
      streams.push(rec);
      await script(payload, {
        event: on.event,
        tool: async (name, args) => {
          const out = await on.tool(name, args);
          rec.tools.push({ name, args, out });
          return out;
        },
      });
    },
  };

  /** A brain that searches, cites the first hit, and suggests a watch. */
  const searching: Script = async (p, on) => {
    await on.event({ type: "status", text: "Searching Front door, Yard…" });
    const found = (await on.tool("search_history", { query: p.question })) as { results: { event_id: string }[] };
    const hit = found.results[0];
    if (hit) await on.event({ type: "moment", moment: { kind: "event", event_id: hit.event_id } });
    await on.event({ type: "delta", text: hit ? "Someone came to the door " : "Nothing found." });
    if (hit) await on.event({ type: "delta", text: "at 10:02 [1]." });
    await on.event({ type: "suggested_watch", instruction: "Tell me when someone comes to the door", sources: [door, "src_elsewhere"] });
    await on.event({ type: "done", content: hit ? "Someone came to the door at 10:02 [1]." : "Nothing found." });
  };

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false, bus, storage,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } } });
    await api.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(api.public.server.address() as { port: number }).port}`;
    acc = (await api.data.accounts.create("Ask")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    door = (await call(owner, "POST", "/v1/sources", { name: "Front door", type: "browser" })).json().id;
    yard = (await call(owner, "POST", "/v1/sources", { name: "Yard", type: "browser" })).json().id;
    for (const [src, key, summary, hot] of [[door, "d1", "A person walked up to the front door.", 1], [yard, "y1", "A person crossed the yard.", 1]] as const) {
      await handleBrainEvent(api.data, undefined, "brain.event", {
        event_key: key, account_id: acc, source_id: src, type: "detection.person", occurred_at: new Date(Date.now() - 3600_000).toISOString(),
        labels: ["person"], confidence: 0.9, summary,
      }, log, async () => [vec(hot)]);
    }
    const events = (await call(owner, "GET", "/v1/events")).json().data;
    doorEvent = events.find((e: any) => e.source.id === door).id;
    yardEvent = events.find((e: any) => e.source.id === yard).id;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });
  const call = (key: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });

  it("creates, lists newest first with cursors, reads and deletes conversations", async () => {
    const a = (await call(owner, "POST", "/v1/conversations", { title: "Deliveries" })).json();
    const b = await call(owner, "POST", "/v1/conversations");
    expect(b.statusCode).toBe(201);
    expect(a).toMatchObject({ id: expect.stringMatching(/^cnv_/), title: "Deliveries" });
    expect(b.json().title).toBeNull();
    const first = (await call(owner, "GET", "/v1/conversations?limit=1")).json();
    expect(first.data[0].id).toBe(b.json().id);
    const second = (await call(owner, "GET", `/v1/conversations?limit=1&cursor=${first.next_cursor}`)).json();
    expect(second.data[0].id).toBe(a.id);
    expect((await call(owner, "GET", `/v1/conversations/${a.id}`)).json()).toMatchObject({ id: a.id, messages: [] });
    expect((await call(owner, "DELETE", `/v1/conversations/${a.id}`)).statusCode).toBe(204);
    expect((await call(owner, "GET", `/v1/conversations/${a.id}`)).statusCode).toBe(404);
    await call(owner, "DELETE", `/v1/conversations/${b.json().id}`);
  });

  it("answers as JSON with a cited moment and a suggested watch, and keeps them", async () => {
    script = searching;
    const c = (await call(owner, "POST", "/v1/conversations")).json();
    const r = await call(owner, "POST", `/v1/conversations/${c.id}/messages`, { content: "When did someone come to the door?" });
    expect(r.statusCode).toBe(200);
    const msg = r.json();
    expect(msg).toMatchObject({ role: "assistant", content: "Someone came to the door at 10:02 [1].", suggested_watch: { instruction: "Tell me when someone comes to the door", sources: [door] } });
    expect(msg.moments).toHaveLength(1);
    expect(msg.moments[0]).toMatchObject({ source_name: expect.any(String), label: expect.stringContaining("person"), snapshot_url: null, clip_url: expect.stringContaining("/playback/") });
    // The brain got every source the owner can see, and a 7-day window.
    const sent = streams.at(-1)!.payload;
    expect(sent.sources.map((s: { id: string }) => s.id).sort()).toEqual([door, yard].sort());
    expect(Date.parse(sent.to) - Date.parse(sent.from)).toBe(7 * 86400_000);
    expect(sent.question).toBe("When did someone come to the door?");
    const conv = (await call(owner, "GET", `/v1/conversations/${c.id}`)).json();
    expect(conv.title).toBe("When did someone come to the door?");
    expect(conv.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(conv.messages[1].moments[0].event_id).toBe(msg.moments[0].event_id);
    expect(conv.messages[1].feedback).toBeNull();
    expect(conv.messages[0].feedback).toBeUndefined(); // only answers take feedback
    // Thumbs on the answer, kept with it; a question is not an answer.
    const fb = await call(owner, "POST", `/v1/conversations/${c.id}/messages/${msg.id}/feedback`, { value: "not_helpful" });
    expect(fb.statusCode).toBe(200);
    expect(fb.json()).toMatchObject({ id: msg.id, feedback: "not_helpful", moments: [{ event_id: msg.moments[0].event_id }] });
    expect((await call(owner, "GET", `/v1/conversations/${c.id}`)).json().messages[1].feedback).toBe("not_helpful");
    expect((await call(owner, "POST", `/v1/conversations/${c.id}/messages/${conv.messages[0].id}/feedback`, { value: "helpful" })).statusCode).toBe(404);
    expect((await call(owner, "POST", `/v1/conversations/${c.id}/messages/${msg.id}/feedback`, { value: "great" })).statusCode).toBe(400);
    // The next question carries the earlier turns as context.
    await call(owner, "POST", `/v1/conversations/${c.id}/messages`, { content: "And before that?" });
    expect(streams.at(-1)!.payload.history).toEqual([
      { role: "user", content: "When did someone come to the door?" }, { role: "assistant", content: "Someone came to the door at 10:02 [1]." },
    ]);
  });

  it("streams status, moment, delta, suggested_watch and done as Server-Sent Events", async () => {
    script = searching;
    const c = (await call(owner, "POST", "/v1/conversations")).json();
    const res = await fetch(`${base}/v1/conversations/${c.id}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${owner}`, accept: "text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ content: "When did someone come to the door?", sources: [door] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = (await res.text()).split("\n\n").filter((b) => b.startsWith("event: ")).map((b) => {
      const [name, data] = b.split("\n");
      return { name: name!.slice(7), data: JSON.parse(data!.slice(6)) };
    });
    expect(events.map((e) => e.name)).toEqual(["status", "moment", "delta", "delta", "suggested_watch", "done"]);
    expect(events[1]!.data).toMatchObject({ source_id: door, source_name: "Front door", event_id: doorEvent });
    expect(events.at(-1)!.data.message).toMatchObject({ role: "assistant", moments: [{ event_id: doorEvent }] });
    // Only the source asked about was searched.
    expect(streams.at(-1)!.tools[0]!.out.results.map((x: { source_id: string }) => x.source_id)).toEqual([door]);
  });

  it("stores a live look's snapshot, signs it per read, and deletes it with the conversation", async () => {
    script = async (_p, on) => {
      await on.event({ type: "status", text: "Looking at Front door…" });
      await on.event({ type: "moment", moment: { kind: "look", source_id: door, at: new Date().toISOString(), label: "A parcel is on the mat.", snapshot_jpeg_b64: Buffer.from("jpeg").toString("base64") } });
      await on.event({ type: "moment", moment: { kind: "look", source_id: "src_not_allowed", label: "x" } });
      await on.event({ type: "done", content: "There's a parcel on the mat [1]." });
    };
    const c = (await call(owner, "POST", "/v1/conversations")).json();
    const msg = (await call(owner, "POST", `/v1/conversations/${c.id}/messages`, { content: "Is there a parcel?" })).json();
    expect(msg.moments).toHaveLength(1);
    expect(msg.moments[0]).toMatchObject({ source_id: door, label: "A parcel is on the mat.", snapshot_url: expect.stringContaining("/media/") });
    const keys = [...objects.keys()].filter((k) => k.includes("/chat-"));
    expect(keys).toHaveLength(1);
    expect((await call(owner, "DELETE", `/v1/conversations/${c.id}`)).statusCode).toBe(204);
    expect([...objects.keys()].filter((k) => k.includes("/chat-"))).toHaveLength(0);
  });

  it("an agent key sees only its own conversations and only its granted sources", async () => {
    script = async (p, on) => {
      const found = (await on.tool("search_history", { query: "person", sources: [yard] })) as { results: unknown[] };
      const listed = (await on.tool("list_events", {})) as { results: { source_id: string }[] };
      await on.event({ type: "moment", moment: { kind: "event", event_id: yardEvent } }); // not granted: dropped
      await on.event({ type: "moment", moment: { kind: "event", event_id: doorEvent } });
      await on.event({ type: "done", content: `found ${found.results.length}, listed ${listed.results.map((x) => x.source_id).join(",")}, sources ${p.sources.map((s: { id: string }) => s.id).join(",")}` });
    };
    const agent = (await call(owner, "POST", "/v1/agents", { name: "Doorbot" })).json();
    await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [door], senses: ["video"] });
    const ownerConv = (await call(owner, "POST", "/v1/conversations")).json();
    expect((await call(agent.api_key, "GET", `/v1/conversations/${ownerConv.id}`)).statusCode).toBe(404);
    const c = (await call(agent.api_key, "POST", "/v1/conversations")).json();
    expect((await call(agent.api_key, "GET", "/v1/conversations")).json().data.map((x: { id: string }) => x.id)).toEqual([c.id]);
    expect((await call(owner, "GET", "/v1/conversations")).json().data.map((x: { id: string }) => x.id)).not.toContain(c.id);
    expect((await call(agent.api_key, "POST", `/v1/conversations/${c.id}/messages`, { content: "anything?", sources: [yard] })).statusCode).toBe(404);
    const msg = (await call(agent.api_key, "POST", `/v1/conversations/${c.id}/messages`, { content: "Anyone at the door?" })).json();
    // The yard search was narrowed to the door; listing saw only the door; the yard moment was refused.
    expect(msg.content).toBe(`found 1, listed ${door}, sources ${door}`);
    expect(msg.moments.map((m: { event_id: string }) => m.event_id)).toEqual([doorEvent]);
    expect(streams.at(-1)!.payload.sources[0]).toMatchObject({ id: door, senses: ["video"], can_look: true });
  });

  it("gives the detector's confidence apart from the search match, and serves an event's snapshot within grants", async () => {
    await api.data.withAccount(acc, (s) => s.db.updateTable("events").set({ snapshot_key: "snapshots/door-1.jpg" }).where("id", "=", doorEvent).execute());
    objects.set("snapshots/door-1.jpg", Buffer.from("door jpeg"));
    let got: Record<string, any> = {};
    script = async (_p, on) => {
      got = {
        found: await on.tool("search_history", { query: "person at the door" }),
        door: await on.tool("event_snapshot", { event_id: doorEvent }),
        yard: await on.tool("event_snapshot", { event_id: yardEvent }),
        missing: await on.tool("event_snapshot", { event_id: "evt_nope" }),
      };
      await on.event({ type: "done", content: "ok" });
    };
    const c = (await call(owner, "POST", "/v1/conversations")).json();
    await call(owner, "POST", `/v1/conversations/${c.id}/messages`, { content: "What was the person holding?" });
    expect(got.found.results[0]).toMatchObject({ confidence: 0.9, match: expect.any(Number) });
    expect(got.found.results[0].score).toBeUndefined();
    expect(got.door).toMatchObject({ event_id: doorEvent, source_id: door, confidence: 0.9, jpeg_b64: Buffer.from("door jpeg").toString("base64") });
    expect(got.door.match).toBeUndefined();
    expect(got.yard).toEqual({ error: "this event has no snapshot" });
    expect(got.missing).toEqual({ error: "event not found" });
    // An agent granted only the door's temperature sees neither camera's events, so neither picture.
    const agent = (await call(owner, "POST", "/v1/agents", { name: "Doorsensor" })).json();
    await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [door], senses: ["temperature"] });
    const ac = (await call(agent.api_key, "POST", "/v1/conversations")).json();
    script = async (_p, on) => {
      got = { door: await on.tool("event_snapshot", { event_id: doorEvent }), yard: await on.tool("event_snapshot", { event_id: yardEvent }) };
      await on.event({ type: "done", content: "ok" });
    };
    await call(agent.api_key, "POST", `/v1/conversations/${ac.id}/messages`, { content: "What was the person holding?" });
    expect(got.door).toEqual({ error: "event not found" });
    expect(got.yard).toEqual({ error: "event not found" });
  });

  it("measures activities for the brain (ADR 0057) and keeps the spans it cites", async () => {
    const t = Date.now() - 2 * 3600_000;
    await storeActivity(api.data, acc, door, { activity_key: "door-p1", kind: "presence", label: "person", started_at: new Date(t).toISOString(),
      last_seen_at: new Date(t + 600_000).toISOString(), ended_at: new Date(t + 600_000).toISOString(), peak_count: 1 }, log);
    // An event with a snapshot inside the span gives the span its picture.
    await api.data.withAccount(acc, (s) => s.db.updateTable("events").set({ snapshot_key: "snapshots/door-1.jpg", occurred_at: new Date(t + 60_000) })
      .where("id", "=", doorEvent).execute());
    let got: Record<string, any> = {};
    script = async (p, on) => {
      got = (await on.tool("query_activity", { measure: "total_duration", what: { label: "person" }, period: "last_24_hours", sources: [door] })) as Record<string, any>;
      got.watches = p.watches;
      got.zones = p.sources.find((x: { id: string }) => x.id === door).zones;
      const e = got.evidence[0];
      await on.event({ type: "moment", moment: { kind: "range", source_id: door, at: e.started_at, until: e.ended_at, label: "At the door for 10 min" } });
      await on.event({ type: "moment", moment: { kind: "range", source_id: "src_elsewhere", at: e.started_at, until: e.ended_at, label: "x" } });
      await on.event({ type: "done", content: "About 10 minutes [1]." });
    };
    const c = (await call(owner, "POST", "/v1/conversations")).json();
    const msg = (await call(owner, "POST", `/v1/conversations/${c.id}/messages`, { content: "How long was someone at the door?" })).json();
    expect(got.value).toBe(600);
    expect(got.time_zone ?? got.window.time_zone).toBeDefined();
    expect(Array.isArray(got.watches)).toBe(true);
    expect(got.zones).toEqual([]); // zone names go to the brain (none set here)
    expect(msg.moments).toHaveLength(1);
    expect(msg.moments[0]).toMatchObject({ source_id: door, label: "At the door for 10 min", until: new Date(t + 600_000).toISOString(),
      snapshot_url: expect.stringContaining("/snapshot.jpg"), clip_url: expect.stringContaining("/playback/") });
    // ...and keeps it when the conversation is read back.
    const read = (await call(owner, "GET", `/v1/conversations/${c.id}`)).json();
    expect(read.messages.at(-1).moments[0].snapshot_url).toEqual(expect.stringContaining("/snapshot.jpg"));
    const bad = await (async () => {
      script = async (_p, on) => {
        got = (await on.tool("query_activity", { measure: "count", what: {} })) as Record<string, any>;
        await on.event({ type: "done", content: "?" });
      };
      await call(owner, "POST", `/v1/conversations/${c.id}/messages`, { content: "?" });
      return got;
    })();
    expect(bad.error).toMatch(/exactly one of/);
  });

  it("fails cleanly when the brain can't answer, and drops the question", async () => {
    script = async (_p, on) => { await on.event({ type: "error", error: "failed" }); };
    const c = (await call(owner, "POST", "/v1/conversations")).json();
    const r = await call(owner, "POST", `/v1/conversations/${c.id}/messages`, { content: "Hello?" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("service_unavailable");
    script = async () => { throw new Error("no responders"); };
    const res = await fetch(`${base}/v1/conversations/${c.id}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${owner}`, accept: "text/event-stream", "content-type": "application/json" }, body: JSON.stringify({ content: "Hello?" }),
    });
    expect(await res.text()).toContain("event: error\ndata: {\"error\":{\"code\":\"service_unavailable\"");
    expect((await call(owner, "GET", `/v1/conversations/${c.id}`)).json().messages).toEqual([]);
    expect((await call(owner, "POST", `/v1/conversations/${c.id}/messages`, { content: "" })).statusCode).toBe(400);
    expect((await call(owner, "POST", "/v1/conversations/cnv_nope/messages", { content: "Hi" })).statusCode).toBe(404);
  });

  it("audits answers", async () => {
    await new Promise((r) => setTimeout(r, 100));
    const entries = (await call(owner, "GET", "/v1/audit")).json().data;
    expect(entries.some((e: { action: string }) => e.action === "POST /v1/conversations/:id/messages")).toBe(true);
  });
});
