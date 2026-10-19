// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Background work that any number of API processes share (ADR 0058), with
// Postgres as the queue: each due row is claimed by one process (FOR UPDATE
// SKIP LOCKED) for a lease, so nothing runs twice and a crashed process's work
// is taken over when its lease runs out.
//   - startJobs: housekeeping jobs, each run once per interval across all processes.
//   - startClaimLoop: a queue (deliveries, clips, scheduled watches) polled on a
//     short timer and woken at once by a kick when this process adds work.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";
import type { DataAccess } from "./data/access.js";

/** This process, as it appears in `scheduled_jobs.claimed_by`. */
export const WORKER_ID = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export interface Job {
  name: string;
  /** Seconds from the end of one run to the start of the next. */
  everyS: number;
  /** How long a run may take before another process may take it over; default 5 min, at least the interval. */
  leaseS?: number;
  /** Returns the state the next run gets (undefined keeps the old one). */
  run(state: unknown): Promise<unknown>;
}

const jobSpec = (j: Job) => `${j.name}:${Math.max(1, Math.round(j.everyS))}:${Math.max(j.leaseS ?? 300, Math.round(j.everyS))}`;

/** Claims the jobs that are due for this process. `at` stands in for now in tests. */
async function claimJobs(data: DataAccess, jobs: Job[], at: Date | undefined, worker: string): Promise<{ name: string; state: unknown }[]> {
  if (!jobs.length) return [];
  const { rows } = await sql<{ name: string; state: unknown }>`select * from claim_jobs(${jobs.map(jobSpec)}, ${worker}, ${at ?? sql`now()`})`.execute(data.db());
  return rows;
}

/** Runs one claimed job and records how it went; the next run is an interval after this one ends. */
async function runClaimed(data: DataAccess, job: Job, state: unknown, log: FastifyBaseLogger | undefined, at: Date | undefined, worker: string) {
  let error: string | null = null;
  let next: unknown;
  try {
    next = await job.run(state);
  } catch (err) {
    error = (err as Error).message?.slice(0, 500) || "failed";
    log?.error({ err, job: job.name }, "background job failed");
  }
  await sql`select finish_job(${job.name}, ${worker}, ${error}, ${next === undefined ? null : JSON.stringify(next)}::jsonb, ${at ?? sql`now()`})`.execute(data.db());
}

/** Claims and runs the jobs that are due, waiting for them. Returns the names that ran. `at` stands in for now in tests. */
export async function runDueJobs(data: DataAccess, jobs: Job[], log?: FastifyBaseLogger, at?: Date, worker = WORKER_ID): Promise<string[]> {
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const rows = await claimJobs(data, jobs, at, worker);
  await Promise.all(rows.map((r) => runClaimed(data, byName.get(r.name)!, r.state, log, at, worker)));
  return rows.map((r) => r.name);
}

/**
 * Runs due jobs on a timer: half the shortest interval, between 1 and 10 s, with jitter so processes don't poll
 * together. Each job runs on its own, so a long one (the Telegram long poll) doesn't hold up the rest.
 */
export function startJobs(data: DataAccess, jobs: Job[], log: FastifyBaseLogger): () => void {
  const pollMs = Math.min(10_000, Math.max(1000, (Math.min(...jobs.map((j) => j.everyS)) * 1000) / 2));
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const local = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    try {
      for (const r of await claimJobs(data, jobs.filter((j) => !local.has(j.name)), undefined, WORKER_ID)) {
        local.add(r.name);
        void runClaimed(data, byName.get(r.name)!, r.state, log, undefined, WORKER_ID)
          .catch((err) => log.error({ err, job: r.name }, "background job could not be recorded"))
          .finally(() => local.delete(r.name));
      }
    } catch (err) {
      log.error({ err }, "background jobs poll failed");
    }
    if (!stopped) schedule();
  };
  const schedule = () => {
    timer = setTimeout(() => void tick(), pollMs * (0.8 + Math.random() * 0.4));
    timer.unref();
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * Runs `handle` for each row `claim` returns, polling every `intervalMs` (with jitter) and at once when `kick`
 * fires. A full batch is followed by another claim straight away.
 */
export function startClaimLoop<T>(o: {
  name: string; intervalMs: number; log: FastifyBaseLogger; kick?: EventTarget; batch: number;
  claim(max: number): Promise<T[]>; handle(row: T): Promise<void>;
}): () => void {
  let running = false;
  let again = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const rows = await o.claim(o.batch);
        await Promise.all(rows.map((r) => o.handle(r).catch((err) => o.log.error({ err, worker: o.name }, "background work failed"))));
        if (rows.length >= o.batch) again = true;
      } while (again && !stopped);
    } catch (err) {
      o.log.error({ err, worker: o.name }, "background work poll failed");
    } finally {
      running = false;
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick().then(schedule), o.intervalMs * (0.8 + Math.random() * 0.4));
    timer.unref();
  };
  const onKick = () => void tick();
  o.kick?.addEventListener("kick", onKick);
  void tick().then(schedule);
  return () => {
    stopped = true;
    clearTimeout(timer);
    o.kick?.removeEventListener("kick", onKick);
  };
}
