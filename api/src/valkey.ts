// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The API's side of Valkey (spec/brain/valkey.json, ADR 0051): the brain's
// event stream (consumer group, acks, re-claims, dead letters), requests to
// any free brain with replies on this instance's channel, chat streams, the
// shared source and watch config with change notifications, snapshots, and
// the frames feed to each camera's brain (through the balancer, ADR 0052).
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";
import { SpanKind, contextFromTraceparent, currentTraceparent, withSpan } from "@senseplane/telemetry";
import type { DataAccess } from "./data/access.js";
import { handleBrainEvent } from "./brain-events.js";
import type { ApiBus, BrainStreamHandlers } from "./indexer.js";
import type { ObjectStorage } from "./storage.js";
import { Balancer } from "./balancer.js";

export const KEYS = {
  events: "sp:brain:events",
  dead: "sp:brain:events:dead",
  rpc: "sp:rpc:brain",
  sources: "sp:sources",
  watches: "sp:watches",
  changed: "sp:changed",
  snapshot: (key: string) => `sp:snapshot:${key}`,
  frames: (brain: string) => `sp:frames:${brain}`,
};
const GROUP = "api";
const MAX_DELIVERIES = 20;
const RECLAIM_IDLE_MS = 2000;

export function connectValkey(url: string, name: string): Redis {
  const r = new Redis(url, { connectionName: name, lazyConnect: false, maxRetriesPerRequest: 3, enableAutoPipelining: true });
  r.on("error", () => undefined); // reconnects on its own; callers see failed commands
  return r;
}

/** Fields of a stream entry, as [k, v, k, v]. */
const fields = (list: string[]) => {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < list.length; i += 2) out[list[i]!] = list[i + 1]!;
  return out;
};

export interface ValkeyBus extends ApiBus {
  valkey: Redis;
  balancer: Balancer;
  /** One frame or audio chunk for the camera's brain. False when no brain is alive. */
  publishMedia(accountId: string, sourceId: string, kind: "frame" | "audio", meta: Record<string, unknown>, data: Buffer): Promise<boolean>;
  /** Called with the source key whenever a source's config changes (any API instance). */
  onSourceChanged(fn: (key: string) => void): void;
}

export async function startBus(
  url: string, data: DataAccess, storage: ObjectStorage | undefined, log: FastifyBaseLogger,
  embed?: (texts: string[]) => Promise<number[][] | undefined>,
): Promise<ValkeyBus> {
  const instance = `api-${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
  const main = connectValkey(url, instance);
  const sub = connectValkey(url, `${instance}-sub`);
  const block = connectValkey(url, `${instance}-events`);
  const replyTo = `sp:rpc:reply:${instance}`;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  const sourceListeners = new Set<(key: string) => void>();
  let stopped = false;
  let embedFn = embed;

  await sub.subscribe(replyTo, KEYS.changed);
  sub.on("message", (channel, message) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    if (channel === KEYS.changed) {
      if (m.bucket === "sources") for (const fn of sourceListeners) fn(String(m.key));
      return;
    }
    const p = pending.get(String(m.id));
    if (!p) return;
    pending.delete(String(m.id));
    clearTimeout(p.timer);
    // A brain-side failure answers with an object with `error`.
    p.resolve(m.ok ? m.result : { error: String(m.error ?? "failed") });
  });

  try {
    await main.xgroup("CREATE", KEYS.events, GROUP, "0", "MKSTREAM");
  } catch (err) {
    if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
  }

  const handle = async (id: string, f: Record<string, string>) => {
    const parent = f.traceparent ? contextFromTraceparent(f.traceparent) : undefined;
    await withSpan(`consume ${f.type}`, {
      kind: SpanKind.CONSUMER, ...(parent ? { parent } : {}),
      attributes: { "messaging.system": "valkey", "messaging.destination.name": KEYS.events, "messaging.consumer.group.name": GROUP, "messaging.message.id": id },
    }, () => handleBrainEvent(data, storage, String(f.type), JSON.parse(f.payload ?? "{}"), log, embedFn));
    await main.xack(KEYS.events, GROUP, id);
  };

  // New entries: handled in order, acked once stored; a failure stays pending and is re-claimed.
  const consume = async () => {
    while (!stopped) {
      try {
        const res = (await block.xreadgroup("GROUP", GROUP, instance, "COUNT", 100, "BLOCK", 5000, "STREAMS", KEYS.events, ">")) as [string, [string, string[]][]][] | null;
        for (const [, entries] of res ?? []) {
          for (const [id, list] of entries) {
            await handle(id, fields(list)).catch((err) => log.error({ err, id }, "brain event failed; will retry"));
          }
        }
      } catch (err) {
        if (stopped) return;
        log.warn({ err }, "brain event stream read failed; retrying");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };
  // Entries another instance (or this one) failed or dropped: claimed after 2 s idle, dead-lettered after 20 tries.
  const reclaim = async () => {
    if (stopped) return;
    try {
      const [, entries] = (await main.xautoclaim(KEYS.events, GROUP, instance, RECLAIM_IDLE_MS, "0-0", "COUNT", 50)) as [string, [string, string[] | null][]];
      for (const [id, list] of entries) {
        if (!list) continue;
        const info = (await main.xpending(KEYS.events, GROUP, "IDLE", 0, id, id, 1)) as [string, string, number, number][];
        const deliveries = info[0]?.[3] ?? 1;
        if (deliveries > MAX_DELIVERIES) {
          await main.xadd(KEYS.dead, "MAXLEN", "~", "10000", "*", ...list);
          await main.xack(KEYS.events, GROUP, id);
          log.error({ id, deliveries }, "brain event dead-lettered after too many failures");
          continue;
        }
        await handle(id, fields(list)).catch((err) => log.error({ err, id, deliveries }, "brain event failed again; will retry"));
      }
    } catch (err) {
      log.warn({ err }, "brain event re-claim failed");
    }
  };
  void consume();
  const reclaimTimer = setInterval(() => void reclaim(), 3000);
  reclaimTimer.unref();

  const balancer = new Balancer(main, log);
  balancer.start();

  const request = async <T>(subject: string, payload: unknown, timeoutMs = 10_000): Promise<T> => {
    const method = subject.replace(/^rpc\.brain\./, "");
    return withSpan(subject, { kind: SpanKind.CLIENT, attributes: { "messaging.system": "valkey", "messaging.destination.name": KEYS.rpc } }, async () => {
      const id = randomUUID();
      const reply = new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${subject} timed out: no brain answered`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      });
      const tp = currentTraceparent();
      await main.lpush(KEYS.rpc, JSON.stringify({ id, method, reply_to: replyTo, deadline: Date.now() + timeoutMs, ...(tp ? { traceparent: tp } : {}), payload }));
      return reply;
    });
  };

  const bus: ValkeyBus = {
    valkey: main,
    balancer,
    async putSourceConfig(accountId, sourceId, config) {
      const key = `${accountId}.${sourceId}`;
      await main.hset(KEYS.sources, key, JSON.stringify(config));
      await main.publish(KEYS.changed, JSON.stringify({ bucket: "sources", key, op: "put" }));
    },
    async putWatch(accountId, watchId, watch) {
      const key = `${accountId}.${watchId}`;
      if (watch) await main.hset(KEYS.watches, key, JSON.stringify(watch));
      else await main.hdel(KEYS.watches, key);
      await main.publish(KEYS.changed, JSON.stringify({ bucket: "watches", key, op: watch ? "put" : "del" }));
    },
    request,
    stream: (subject, payload, on, limits) => brainStream(main, request, subject, payload, on, limits),
    async latestSnapshot(accountId, sourceId) {
      const b = await main.getBuffer(KEYS.snapshot(`${accountId}.${sourceId}`));
      return b?.length ? new Uint8Array(b) : undefined;
    },
    async publishMedia(accountId, sourceId, kind, meta, payload) {
      const brain = await balancer.brainFor(`${accountId}.${sourceId}`);
      if (!brain) return false;
      // A traced frame (sampled by the media plane) carries its trace to the brain (brain.frame).
      const tp = currentTraceparent();
      await main.xadd(KEYS.frames(brain), "MAXLEN", "~", "200", "*",
        "kind", kind, "account_id", accountId, "source_id", sourceId, "meta", JSON.stringify(meta), ...(tp ? ["traceparent", tp] : []), "data", payload);
      return true;
    },
    onSourceChanged(fn) {
      sourceListeners.add(fn);
    },
    async close() {
      stopped = true;
      clearInterval(reclaimTimer);
      balancer.stop();
      for (const p of pending.values()) clearTimeout(p.timer);
      block.disconnect();
      sub.disconnect();
      await main.quit().catch(() => main.disconnect());
    },
  };
  // Events are embedded by the brain (embed) for memory search.
  embedFn ??= async (texts) => {
    try {
      return (await request<{ vectors: number[][] }>("rpc.brain.embed", { texts }, 5000)).vectors;
    } catch {
      return undefined; // brain down: the event is still stored, just not searchable by meaning
    }
  };
  log.info({ instance }, "api bus started on valkey (brain events, requests, config, frames)");
  return bus;
}

/**
 * A streamed brain request (chat, ADR 0041): the brain acks, then pushes
 * events (and tool calls) onto `{stream}:events`; tool answers go back on
 * `{stream}:tool:{call_id}`. Resolves after `done` or `error`.
 */
export async function brainStream(
  main: Redis, request: ApiBus["request"], subject: string, payload: Record<string, unknown>, on: BrainStreamHandlers,
  { idleMs = 60_000, totalMs = 180_000 }: { idleMs?: number; totalMs?: number } = {},
) {
  const stream = `sp:chat:${randomUUID()}`;
  const conn = main.duplicate();
  conn.on("error", () => undefined);
  const deadline = Date.now() + totalMs;
  try {
    const ack = await request<{ ok?: boolean; error?: string }>(subject, { ...payload, stream }, 10_000);
    if (ack?.error) throw new Error(String(ack.error));
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("the brain took too long");
      const got = await conn.blpop(`${stream}:events`, Math.max(1, Math.ceil(Math.min(idleMs, left) / 1000)));
      if (!got) throw new Error(Date.now() >= deadline ? "the brain took too long" : "the brain went quiet");
      const e = JSON.parse(got[1]) as { type: string; call_id?: string; name?: string; args?: Record<string, unknown> };
      if (e.type === "tool") {
        void (async () => {
          let out: unknown;
          try {
            out = await on.tool(String(e.name), e.args ?? {});
          } catch (err) {
            out = { error: err instanceof Error ? err.message : "tool failed" };
          }
          const key = `${stream}:tool:${e.call_id}`;
          await main.multi().rpush(key, JSON.stringify(out)).expire(key, 60).exec();
        })();
        continue;
      }
      await on.event(e);
      if (e.type === "done" || e.type === "error") return;
    }
  } finally {
    conn.disconnect();
    await main.del(`${stream}:events`).catch(() => undefined);
  }
}
