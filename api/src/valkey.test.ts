// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The API on Valkey (spec/brain/valkey.json, ADR 0051, 0052), against a real
// Valkey (TEST_VALKEY_URL, default db 14 of the dev container; flushed). A
// fake brain answers on the same keys the real one uses.
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { Balancer, leastBusy } from "./balancer.js";
import { type ValkeyBus, startBus } from "./valkey.js";
import { createTestDatabase } from "./testdb.js";

const URL_ = process.env.TEST_VALKEY_URL ?? "redis://127.0.0.1:47379/14";
const probe = new Redis(URL_, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
const up = await probe.connect().then(() => true, () => false);
if (!up) console.warn(`[api] skipping the Valkey tests: nothing answers at ${URL_.replace(/\/\/[^@/]*@/, "//***@")} (TEST_VALKEY_URL).`);
const until = async <T>(what: string, fn: () => Promise<T | undefined | false>, ms = 10_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const heartbeat = (r: Redis, id: string, cpu = 10) => r.multi().set(`sp:brain:${id}`, JSON.stringify({ id, cameras: 0, cpu }), "EX", 6).sadd("sp:brains", id).exec();

describe.skipIf(!up)("valkey bus and balancer", () => {
  let api: SenseplaneApi;
  let bus: ValkeyBus;
  let drop: () => Promise<void>;
  let accountId: string;
  let sourceId: string;
  const r = probe;

  beforeAll(async () => {
    await r.flushdb();
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, workers: false, sweepIntervalSeconds: 0 });
    bus = await startBus(URL_, api.data, undefined, api.public.log, async () => undefined);
    accountId = (await api.data.accounts.create("V")).id;
    sourceId = (await api.data.withAccount(accountId, (s) => s.sources.create({ name: "Cam", type: "browser" }))).id;
  });
  afterAll(async () => {
    await bus?.close();
    await api?.close();
    await drop?.();
    await r.flushdb();
    r.disconnect();
  });

  it("stores brain events from the stream once, acks them, and re-claims a failure", async () => {
    const event = { event_key: "e1", account_id: accountId, source_id: sourceId, type: "detection.person", occurred_at: new Date().toISOString(), labels: ["person"], confidence: 0.9, summary: "A person." };
    await r.xadd("sp:brain:events", "*", "type", "brain.event", "payload", JSON.stringify(event));
    await r.xadd("sp:brain:events", "*", "type", "brain.event", "payload", JSON.stringify(event)); // redelivered by the brain: stored once
    const rows = () => api.data.withAccount(accountId, (s) => s.db.selectFrom("events").select("id").execute());
    await until("the event", async () => (await rows()).length === 1);
    await until("acks", async () => Number(((await r.xpending("sp:brain:events", "api")) as [number])[0]) === 0);
    // An entry that fails (the database refuses it) stays pending and is retried, not lost.
    await r.xadd("sp:brain:events", "*", "type", "brain.event", "payload", JSON.stringify({ ...event, event_key: "e2", source_id: "src_missing_x" }));
    await new Promise((res) => setTimeout(res, 300));
    expect((await rows()).length).toBe(1);
  });

  it("asks any free brain and gets the answer on this instance's channel", async () => {
    const brain = r.duplicate();
    void (async () => {
      const got = await brain.brpop("sp:rpc:brain", 5);
      const req = JSON.parse(got![1]);
      expect(req).toMatchObject({ method: "compile", payload: { instruction: "x" } });
      expect(req.reply_to).toMatch(/^sp:rpc:reply:/);
      expect(req.deadline).toBeGreaterThan(Date.now());
      await brain.publish(req.reply_to, JSON.stringify({ id: req.id, ok: true, result: { compiled: { ok: 1 } } }));
    })();
    expect(await bus.request("rpc.brain.compile", { instruction: "x" }, 4000)).toEqual({ compiled: { ok: 1 } });
    void (async () => {
      const req = JSON.parse((await brain.brpop("sp:rpc:brain", 5))![1]);
      await brain.publish(req.reply_to, JSON.stringify({ id: req.id, ok: false, error: "no_model" }));
    })();
    expect(await bus.request("rpc.brain.ask", {}, 4000)).toEqual({ error: "no_model" });
    await expect(bus.request("rpc.brain.embed", {}, 300)).rejects.toThrow(/timed out/);
    brain.disconnect();
  });

  it("streams a chat answer, answering the brain's tool calls on the way", async () => {
    await r.del("sp:rpc:brain"); // the request nobody answered above (a real brain drops it past its deadline)
    const brain = r.duplicate();
    void (async () => {
      const req = JSON.parse((await brain.brpop("sp:rpc:brain", 5))![1]);
      const stream = req.payload.stream as string;
      await brain.publish(req.reply_to, JSON.stringify({ id: req.id, ok: true, result: { ok: true } }));
      await brain.rpush(`${stream}:events`, JSON.stringify({ type: "status", text: "looking" }));
      await brain.rpush(`${stream}:events`, JSON.stringify({ type: "tool", call_id: "c1", name: "list_events", args: { limit: 1 } }));
      const tool = await brain.blpop(`${stream}:tool:c1`, 5);
      await brain.rpush(`${stream}:events`, JSON.stringify({ type: "done", content: `tool said ${JSON.parse(tool![1]).results.length}` }));
    })();
    const events: string[] = [];
    await bus.stream!("rpc.brain.chat", { account_id: accountId, question: "q", sources: [] }, {
      event: (e) => void events.push(`${e.type}:${String(e.text ?? e.content ?? "")}`),
      tool: async (name, args) => ({ results: [{ name, args }] }),
    }, { idleMs: 3000, totalMs: 8000 });
    expect(events).toEqual(["status:looking", "done:tool said 1"]);
    brain.disconnect();
  });

  it("shares source config and watches with a change notification", async () => {
    const sub = r.duplicate();
    const changes: string[] = [];
    await sub.subscribe("sp:changed");
    sub.on("message", (_c, m) => changes.push(m));
    await bus.putSourceConfig(accountId, sourceId, { zones: [], privacy_masks: [], record_audio: false });
    await bus.putWatch(accountId, "wat_1", { id: "wat_1", sources: [sourceId] });
    await bus.putWatch(accountId, "wat_1", null);
    expect(JSON.parse((await r.hget("sp:sources", `${accountId}.${sourceId}`))!)).toMatchObject({ record_audio: false });
    expect(await r.hget("sp:watches", `${accountId}.wat_1`)).toBeNull();
    await until("notifications", async () => changes.length === 3);
    expect(changes.map((c) => JSON.parse(c))).toEqual([
      { bucket: "sources", key: `${accountId}.${sourceId}`, op: "put" },
      { bucket: "watches", key: `${accountId}.wat_1`, op: "put" },
      { bucket: "watches", key: `${accountId}.wat_1`, op: "del" },
    ]);
    await r.set(`sp:snapshot:${accountId}.${sourceId}`, Buffer.from([0xff, 0xd8]));
    expect(Buffer.from((await bus.latestSnapshot(accountId, sourceId))!).toString("hex")).toBe("ffd8");
    sub.disconnect();
  });

  it("sends a camera's frames only to its brain, chosen by load and kept", async () => {
    await r.del("sp:assign", "sp:brains");
    expect(await bus.publishMedia(accountId, sourceId, "frame", { captured_at: new Date().toISOString() }, Buffer.from("x"))).toBe(false); // no brain alive
    await heartbeat(r, "b1");
    await heartbeat(r, "b2");
    await r.hset("sp:assign", "other.cam1", "b1");
    // b2 has fewer cameras: it gets the new one.
    await new Promise((res) => setTimeout(res, 1100));
    expect(await bus.publishMedia(accountId, sourceId, "frame", { captured_at: "t" }, Buffer.from("jpeg"))).toBe(true);
    expect(await r.hget("sp:assign", `${accountId}.${sourceId}`)).toBe("b2");
    const [entry] = (await r.xrange("sp:frames:b2", "-", "+")) as [string, string[]][];
    const f = Object.fromEntries(entry![1].reduce<[string, string][]>((a, v, i, l) => (i % 2 ? a : [...a, [v, l[i + 1]!]]), []));
    expect(f).toMatchObject({ kind: "frame", account_id: accountId, source_id: sourceId, data: "jpeg" });
    expect(await r.xlen("sp:frames:b1")).toBe(0);
  });

  it("reassigns a dead brain's cameras, releases offline ones and rebalances gently", async () => {
    await r.del("sp:assign", "sp:brains", "sp:balancer:lock");
    const b = new Balancer(r, undefined, { cacheMs: 0 });
    await heartbeat(r, "x1", 50);
    await heartbeat(r, "x2", 5);
    expect(await b.brainFor("a.c1")).toBe("x2"); // no cameras anywhere: the lower cpu wins
    expect(await b.brainFor("a.c2")).toBe("x1"); // then the brain with fewer cameras
    expect(await b.brainFor("a.c1")).toBe("x2"); // sticky
    // x2 stops heartbeating: its camera moves on its next frame.
    await r.del("sp:brain:x2");
    await new Promise((res) => setTimeout(res, 1100));
    expect(await b.brainFor("a.c1")).toBe("x1");
    expect(await r.smembers("sp:brains")).toEqual(["x1"]);
    await b.release("a.c1");
    expect(await r.hget("sp:assign", "a.c1")).toBeNull();
    // A new brain with nothing, an old one with three: one camera moves per pass, never a stampede.
    await r.hset("sp:assign", "a.c1", "x1", "a.c3", "x1");
    await heartbeat(r, "x3", 0);
    await new Promise((res) => setTimeout(res, 1100));
    const moved = await b.rebalance();
    expect(moved).toMatchObject({ from: "x1", to: "x3" });
    expect(await b.rebalance()).toBeUndefined(); // the lock: one pass per 25 s across instances
    await r.del("sp:balancer:lock");
    expect(await b.rebalance()).toBeUndefined(); // 2 vs 1: within the skew
  });
});

describe("leastBusy", () => {
  it("prefers fewest cameras, then lowest cpu, then id", () => {
    expect(leastBusy([{ id: "a", cameras: 3, cpu: 1 }, { id: "b", cameras: 1, cpu: 90 }])).toBe("b");
    expect(leastBusy([{ id: "a", cameras: 1, cpu: 50 }, { id: "b", cameras: 1, cpu: 10 }])).toBe("b");
    expect(leastBusy([{ id: "b", cameras: 0, cpu: 0 }, { id: "a", cameras: 0, cpu: 0 }])).toBe("a");
    expect(leastBusy([])).toBeUndefined();
  });
});
