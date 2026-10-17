// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The brain balancer (ADR 0052, spec/brain/valkey.json `balancer`). Each
// camera is assigned to one live brain, chosen by load, and stays there: its
// frames go only to that brain. Brains heartbeat `sp:brain:{id}` (6 s
// expiry); a camera whose brain stopped heartbeating is reassigned on its next
// frame. The same code runs for one brain on a laptop and many in production.
import type { Redis } from "ioredis";
import type { FastifyBaseLogger } from "fastify";

const ASSIGN = "sp:assign";
const BRAINS = "sp:brains";
const LOCK = "sp:balancer:lock";
const brainKey = (id: string) => `sp:brain:${id}`;

/** Set field to `next` only if it still holds `expected` ("" = unset). Returns the value now held. */
const CAS = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if (cur == false and ARGV[2] == '') or cur == ARGV[2] then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
  return ARGV[3]
end
return cur`;

export interface BrainLoad {
  id: string;
  cameras: number;
  cpu: number;
}

export class Balancer {
  private cache = new Map<string, { brain: string; at: number }>();
  private live?: { at: number; brains: Map<string, { cpu: number }> };
  private timer?: NodeJS.Timeout;

  constructor(private readonly r: Redis, private readonly log?: FastifyBaseLogger, private readonly o: { cacheMs?: number; rebalanceEveryMs?: number; skew?: number } = {}) {}

  start() {
    this.timer = setInterval(() => void this.rebalance().catch((err) => this.log?.warn({ err }, "rebalance failed")), this.o.rebalanceEveryMs ?? 30_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Live brains and their heartbeat load, cached for a second. */
  async liveBrains(): Promise<Map<string, { cpu: number }>> {
    if (this.live && Date.now() - this.live.at < 1000) return this.live.brains;
    const ids = await this.r.smembers(BRAINS);
    const brains = new Map<string, { cpu: number }>();
    if (ids.length) {
      const beats = await this.r.mget(...ids.map(brainKey));
      const dead: string[] = [];
      ids.forEach((id, i) => {
        const b = beats[i];
        if (!b) return void dead.push(id);
        try {
          brains.set(id, { cpu: Number(JSON.parse(b).cpu ?? 0) || 0 });
        } catch {
          brains.set(id, { cpu: 0 });
        }
      });
      if (dead.length) await this.r.srem(BRAINS, ...dead);
    }
    this.live = { at: Date.now(), brains };
    return brains;
  }

  /** Cameras per live brain, from the assignment hash (the source of truth). */
  async loads(): Promise<BrainLoad[]> {
    const live = await this.liveBrains();
    const counts = new Map<string, number>([...live.keys()].map((id) => [id, 0]));
    for (const brain of Object.values(await this.r.hgetall(ASSIGN))) if (counts.has(brain)) counts.set(brain, counts.get(brain)! + 1);
    return [...live.entries()].map(([id, b]) => ({ id, cameras: counts.get(id) ?? 0, cpu: b.cpu }));
  }

  /** The camera's brain, assigning one (atomically) if it has none or its brain is dead. Undefined when no brain is alive. */
  async brainFor(camera: string): Promise<string | undefined> {
    const hit = this.cache.get(camera);
    const live = await this.liveBrains();
    if (hit && Date.now() - hit.at < (this.o.cacheMs ?? 2000) && live.has(hit.brain)) return hit.brain;
    const current = (await this.r.hget(ASSIGN, camera)) ?? "";
    if (current && live.has(current)) {
      this.cache.set(camera, { brain: current, at: Date.now() });
      return current;
    }
    const pick = leastBusy(await this.loads());
    if (!pick) return undefined;
    const held = String(await this.r.eval(CAS, 1, ASSIGN, camera, current, pick));
    if (held !== current) this.log?.info({ camera, brain: held, from: current || undefined }, current ? "camera reassigned from a dead brain" : "camera assigned to a brain");
    this.cache.set(camera, { brain: held, at: Date.now() });
    return live.has(held) ? held : undefined;
  }

  /** The camera went offline: its brain lets go of it. */
  async release(camera: string) {
    this.cache.delete(camera);
    await this.r.hdel(ASSIGN, camera);
  }

  /**
   * Moves one camera from the busiest brain to the least busy one when they
   * differ by `skew` (2) or more cameras. One instance at a time (a lock), one
   * camera per pass: gentle, so a new brain fills up over minutes, not at once.
   */
  async rebalance(): Promise<{ camera: string; from: string; to: string } | undefined> {
    const got = await this.r.set(LOCK, "1", "EX", 25, "NX");
    if (got !== "OK") return undefined;
    const loads = await this.loads();
    if (loads.length < 2) return undefined;
    const sorted = [...loads].sort((a, b) => b.cameras - a.cameras || b.cpu - a.cpu);
    const busiest = sorted[0]!;
    const idlest = loads.find((l) => l.id === leastBusy(loads))!;
    if (busiest.cameras - idlest.cameras < (this.o.skew ?? 2)) return undefined;
    const assign = await this.r.hgetall(ASSIGN);
    const camera = Object.keys(assign).find((k) => assign[k] === busiest.id);
    if (!camera) return undefined;
    const held = String(await this.r.eval(CAS, 1, ASSIGN, camera, busiest.id, idlest.id));
    if (held !== idlest.id) return undefined;
    this.cache.delete(camera);
    this.log?.info({ camera, from: busiest.id, to: idlest.id }, "rebalanced a camera");
    return { camera, from: busiest.id, to: idlest.id };
  }
}

/** Fewest cameras, then lowest CPU, then id (stable). A new brain has none, so it takes new cameras first. */
export function leastBusy(loads: BrainLoad[]): string | undefined {
  return [...loads].sort((a, b) => a.cameras - b.cameras || a.cpu - b.cpu || a.id.localeCompare(b.id))[0]?.id;
}
