// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Retention sweeper (ADR 0016, 0032): the authoritative deleter of raw segments.
// Days mode: effective retention = source.retention_days ?? account.retention_days
// (null keeps footage until deleted). Fill mode: keep as much raw footage as a
// byte cap holds and delete the oldest first.
// Deletes objects first, then index rows, so a crash never leaves an index
// row pointing at nothing it can't retry. Clips are separate copies and are
// never touched. One sweeper at a time across replicas (advisory lock).
import { sql } from "kysely";
import type { FastifyBaseLogger } from "fastify";
import type { DataAccess } from "./data/access.js";
import type { ObjectStorage } from "./storage.js";

const LOCK_ID = 0x5e75; // arbitrary, constant
const BATCH = 1000;

export interface SweepResult {
  sources: number;
  segments: number;
  objects: number;
  /** Sensor readings past retention. */
  readings?: number;
}

/** The deployment's storage cap for an account (the quota provider's), used by fill mode when no byte cap is set. */
export type StorageCap = (accountId: string) => Promise<number | null | undefined>;

export async function sweepOnce(data: DataAccess, storage: ObjectStorage, now = new Date(), storageCap?: StorageCap): Promise<SweepResult> {
  const result: SweepResult = { sources: 0, segments: 0, objects: 0 };
  const targets = await data.retentionTargets();
  for (const t of targets) {
    result.sources++;
    const cutoff = new Date(now.getTime() - t.retention_days * 86400_000);
    for (;;) {
      const batch = await data.withAccount(t.account_id, (s) =>
        s.db.selectFrom("segments").select(["id", "key", "init_key"]).where("source_id", "=", t.source_id)
          .where("start_at", "<", cutoff).orderBy("start_at").limit(BATCH).execute(),
      );
      if (!batch.length) break;
      const ids = batch.map((b) => b.id);
      // Init segments no remaining segment still needs.
      const inits = [...new Set(batch.map((b) => b.init_key))];
      const stillUsed = await data.withAccount(t.account_id, (s) =>
        s.db.selectFrom("segments").select("init_key").distinct().where("init_key", "in", inits).where("id", "not in", ids).execute(),
      );
      const used = new Set(stillUsed.map((r) => r.init_key));
      const keys = [...batch.map((b) => b.key), ...inits.filter((k) => !used.has(k))];
      result.objects += await storage.deleteMany(keys);
      await data.withAccount(t.account_id, (s) => s.db.deleteFrom("segments").where("id", "in", ids).execute());
      result.segments += batch.length;
      if (batch.length < BATCH) break;
    }
  }
  await sweepFill(data, storage, result, storageCap);
  result.readings = await sweepReadings(data, now);
  return result;
}

/** Sensor readings follow the same retention days as footage (source, else account); ADR 0045. */
export async function sweepReadings(data: DataAccess, now = new Date()): Promise<number> {
  let deleted = 0;
  for (const t of await data.readingsRetentionTargets()) {
    const cutoff = new Date(now.getTime() - t.retention_days * 86400_000);
    const r = await data.withAccount(t.account_id, (s) =>
      s.db.deleteFrom("sensor_readings").where("source_id", "=", t.source_id).where("measured_at", "<", cutoff).executeTakeFirst());
    deleted += Number(r.numDeletedRows);
  }
  return deleted;
}

/** Deletes a batch of segments (objects first, then index rows) and any init segments nothing else uses. */
async function deleteSegments(data: DataAccess, storage: ObjectStorage, accountId: string, batch: { id: number | string; key: string; init_key: string }[], result: SweepResult) {
  if (!batch.length) return;
  const ids = batch.map((b) => String(b.id));
  const inits = [...new Set(batch.map((b) => b.init_key))];
  const stillUsed = await data.withAccount(accountId, (s) =>
    s.db.selectFrom("segments").select("init_key").distinct().where("init_key", "in", inits).where("id", "not in", ids).execute(),
  );
  const used = new Set(stillUsed.map((r) => r.init_key));
  result.objects += await storage.deleteMany([...batch.map((b) => b.key), ...inits.filter((k) => !used.has(k))]);
  await data.withAccount(accountId, (s) => s.db.deleteFrom("segments").where("id", "in", ids).execute());
  result.segments += batch.length;
}

/**
 * Fill mode: a source with its own byte cap is capped alone; sources that follow
 * the account's fill mode share the account's cap, from which clips and
 * snapshots are subtracted first (they are kept until deleted). Clips are never
 * touched: they are separate copies.
 */
async function sweepFill(data: DataAccess, storage: ObjectStorage, result: SweepResult, storageCap?: StorageCap) {
  const { rows } = await sql<{ account_id: string }>`select * from fill_retention_accounts()`.execute(data.db());
  for (const { account_id } of rows) {
    const plan = await data.withAccount(account_id, async (s) => {
      const acc = await s.db.selectFrom("accounts").select(["retention_mode", "retention_max_bytes"]).executeTakeFirstOrThrow();
      const sources = await s.db.selectFrom("sources").select(["id", "retention_mode", "retention_max_bytes"]).execute();
      const kept = await s.db.selectFrom("clips").select(sql<string>`coalesce(sum(bytes), 0)`.as("b")).executeTakeFirstOrThrow();
      const snaps = await s.db.selectFrom("events").select(sql<string>`coalesce(sum(snapshot_bytes), 0)`.as("b")).executeTakeFirstOrThrow();
      return { acc, sources, keptBytes: Number(kept.b) + Number(snaps.b) };
    });
    const groups: { sourceIds: string[]; cap: number }[] = [];
    for (const src of plan.sources) {
      if (src.retention_mode === "fill" && src.retention_max_bytes != null) groups.push({ sourceIds: [src.id], cap: Number(src.retention_max_bytes) });
    }
    const followers = plan.sources.filter((s) => (s.retention_mode ?? plan.acc.retention_mode) === "fill" && !(s.retention_mode === "fill" && s.retention_max_bytes != null));
    const accountCap = plan.acc.retention_max_bytes != null ? Number(plan.acc.retention_max_bytes) : await storageCap?.(account_id);
    if (followers.length && accountCap != null) groups.push({ sourceIds: followers.map((s) => s.id), cap: Math.max(0, accountCap - plan.keptBytes) });
    for (const g of groups) {
      const total = Number((await data.withAccount(account_id, (s) =>
        s.db.selectFrom("segments").select(sql<string>`coalesce(sum(bytes), 0)`.as("b")).where("source_id", "in", g.sourceIds).executeTakeFirstOrThrow())).b);
      let excess = total - g.cap;
      if (excess <= 0) continue;
      result.sources += g.sourceIds.length;
      while (excess > 0) {
        const batch = await data.withAccount(account_id, (s) =>
          s.db.selectFrom("segments").select(["id", "key", "init_key", "bytes"]).where("source_id", "in", g.sourceIds).orderBy("start_at").orderBy("id").limit(BATCH).execute());
        if (!batch.length) break;
        const take: typeof batch = [];
        for (const b of batch) {
          if (excess <= 0) break;
          take.push(b);
          excess -= Number(b.bytes);
        }
        await deleteSegments(data, storage, account_id, take, result);
        if (take.length < batch.length) break;
      }
    }
  }
}

export function startSweeper(data: DataAccess, storage: ObjectStorage, log: FastifyBaseLogger, intervalSeconds: number, storageCap?: StorageCap) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const got = await data.tryAdvisoryLock(LOCK_ID, async () => sweepOnce(data, storage, new Date(), storageCap));
      if (got && got.segments) log.info({ sweep: got }, "retention sweep deleted raw segments");
    } catch (err) {
      log.error({ err }, "retention sweep failed; will retry");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalSeconds * 1000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}

export { sql };
