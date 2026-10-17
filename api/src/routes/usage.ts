// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Usage meters, the hourly storage sample, and usage limits (ADR 0025).
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { DataAccess } from "../data/access.js";
import type { ApiBus } from "../indexer.js";
import type { MediaControl } from "../media-driver.js";
import { closeViewers } from "./live.js";
import type { Quota, UsageLimit, UsageMeter } from "../module.js";

const KINDS = ["verify", "look", "ask", "summary", "compile", "chat"];
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const dayStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export async function meters(data: DataAccess, accountId: string, from: Date, to: Date) {
  return data.withAccount(accountId, async (s) => {
    const rows = await s.db.selectFrom("usage_records")
      .select(["kind", "detail", "source_id", sql<string>`date_trunc('day', at AT TIME ZONE 'UTC')::date::text`.as("day"), sql<string>`sum(quantity)`.as("n")])
      .where("at", ">=", from).where("at", "<", to)
      .groupBy(["kind", "detail", "source_id", sql`date_trunc('day', at AT TIME ZONE 'UTC')`]).execute();
    const sources = await s.sources.list();
    return { rows, sources };
  });
}

export function summarize(rows: { kind: string; detail: string | null; source_id: string | null; day: string; n: string }[]) {
  const camMs = rows.filter((r) => r.kind === "camera_ms");
  const sum = (xs: typeof rows) => xs.reduce((a, r) => a + Number(r.n), 0);
  const by = (xs: typeof rows, key: (r: (typeof rows)[number]) => string) => {
    const out: Record<string, number> = {};
    for (const r of xs) out[key(r)] = (out[key(r)] ?? 0) + Number(r.n);
    return out;
  };
  const cameraMinutes = sum(camMs) / 60_000;
  const storageGbHours = sum(rows.filter((r) => r.kind === "storage_byte_hours")) / 1e9;
  const checks = rows.filter((r) => r.kind === "ai_checks");
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const [k, v] of Object.entries(by(checks, (r) => r.detail ?? "other"))) byKind[k] = v;
  // Live view (ADR 0042): viewer-minutes, one person watching one source for one minute.
  const live = rows.filter((r) => r.kind === "live_view_ms");
  const days = [...new Set(rows.map((r) => r.day))].sort();
  return {
    camera_minutes: round(cameraMinutes),
    camera_minutes_by_resolution: Object.fromEntries(Object.entries(by(camMs, (r) => r.detail ?? "other")).map(([k, v]) => [k, round(v / 60_000)])),
    camera_minutes_by_source: Object.fromEntries(Object.entries(by(camMs, (r) => r.source_id ?? "unknown")).map(([k, v]) => [k, round(v / 60_000)])),
    storage_gb_hours: round(storageGbHours, 4),
    storage_gb_month: round(storageGbHours / 730, 6),
    ai_checks: sum(checks),
    ai_checks_by_kind: byKind,
    recording_hours: round(cameraMinutes / 60, 4),
    storage_gb_days: round(storageGbHours / 24, 4),
    frames_analysed: sum(rows.filter((r) => r.kind === "frames_analysed")),
    vlm_calls: sum(rows.filter((r) => r.kind === "vlm_calls")),
    live_view_minutes: round(sum(live) / 60_000),
    live_view_minutes_by_source: Object.fromEntries(Object.entries(by(live, (r) => r.source_id ?? "unknown")).map(([k, v]) => [k, round(v / 60_000)])),
    by_day: days.map((day) => {
      const d = rows.filter((r) => r.day === day);
      const dl = d.filter((r) => r.kind === "live_view_ms");
      return {
        day, camera_minutes: round(sum(d.filter((r) => r.kind === "camera_ms")) / 60_000), storage_gb_hours: round(sum(d.filter((r) => r.kind === "storage_byte_hours")) / 1e9, 4), ai_checks: sum(d.filter((r) => r.kind === "ai_checks")),
        live_view_minutes: round(sum(dl) / 60_000),
        ...(dl.length ? { live_view_minutes_by_source: Object.fromEntries(Object.entries(by(dl, (r) => r.source_id ?? "unknown")).map(([k, v]) => [k, round(v / 60_000)])) } : {}),
      };
    }),
  };
}

/** Live view sessions joined and not yet ended (ADR 0042). */
async function watchingNow(data: DataAccess, accountId: string): Promise<number> {
  const row = await data.withAccount(accountId, (s) =>
    s.db.selectFrom("live_sessions").select(sql<string>`count(*)`.as("n")).where("ended_at", "is", null).where("joined_at", "is not", null).executeTakeFirstOrThrow());
  return Number(row.n);
}

export function registerUsageRoutes(app: FastifyInstance, deps: { data: DataAccess; quotaFor(accountId: string): Promise<Quota> }) {
  app.get<{ Querystring: { from?: string; to?: string } }>("/v1/usage", async (req) => {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : monthStart(to);
    const { rows, sources } = await meters(deps.data, req.accountId!, from, to);
    const quota = await deps.quotaFor(req.accountId!);
    const quotas: Record<string, number> = {};
    if (quota.maxSources !== null) quotas.max_registered_sources = quota.maxSources;
    if (quota.maxActiveSources) quotas.max_active_sources = quota.maxActiveSources;
    if (quota.maxLiveViewers) quotas.max_live_viewers = quota.maxLiveViewers;
    for (const l of quota.usageLimits ?? []) quotas[`${l.meter}_per_${l.period}`] = l.limit;
    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      ...summarize(rows),
      sources: {
        registered: sources.length, active: sources.filter((x) => x.status === "online").length,
        max_registered: quota.maxSources, max_active: quota.maxActiveSources ?? null,
      },
      // People watching live right now, across the account ("2 of 3 watching now").
      live_viewers_now: await watchingNow(deps.data, req.accountId!),
      ...(Object.keys(quotas).length ? { quotas } : {}),
    };
  });
}

/** One storage sample per account per hour: bytes stored × 1 hour (idempotent across API replicas). */
export async function sampleStorage(data: DataAccess, now = new Date()) {
  const hour = now.toISOString().slice(0, 13);
  const rows = (await sql<{ account_id: string; bytes: string }>`select * from storage_bytes_by_account()`.execute(data.db())).rows;
  for (const r of rows) {
    if (Number(r.bytes) <= 0) continue;
    await data.withAccount(r.account_id, (s) =>
      s.db.insertInto("usage_records").values({ account_id: r.account_id, kind: "storage_byte_hours", quantity: r.bytes, at: new Date(`${hour}:00:00Z`), dedupe_key: `storage:${hour}` })
        .onConflict((oc) => oc.columns(["account_id", "dedupe_key"]).where("dedupe_key", "is not", null).doNothing()).execute());
  }
  return rows.length;
}

/** What each usage limit allows right now, by meter. */
export async function overLimits(data: DataAccess, accountId: string, limits: UsageLimit[]): Promise<{ meter: UsageMeter; used: number; limit: number; hard: boolean }[]> {
  const out = [];
  for (const l of limits) {
    const from = l.period === "day" ? dayStart() : monthStart();
    const s = summarize((await meters(data, accountId, from, new Date())).rows);
    const used = l.meter === "ai_checks" ? s.ai_checks : l.meter === "camera_minutes" ? s.camera_minutes : l.meter === "live_view_minutes" ? s.live_view_minutes
      : s.storage_gb_hours / ((Date.now() - from.getTime()) / 3600_000 || 1);
    if (used >= l.limit) out.push({ meter: l.meter, used, limit: l.limit, hard: (l.enforcement ?? "hard") === "hard" });
  }
  return out;
}

/** Meters that stop cameras when a hard limit is hit (live view and AI checks don't). */
export const isIngestMeter = (m: string) => m === "camera_minutes" || m === "storage_gb";

/** Applies usage limits: hard ones pause watches (AI), disconnect cameras (ingest, storage) or end live viewers (live view); notify ones only report. Returns accounts over a hard limit. */
export async function enforceLimits(deps: {
  data: DataAccess; bus?: ApiBus; media?: MediaControl; quotaFor(accountId: string): Promise<Quota>;
  onUsageLimit?: (accountId: string, meter: UsageMeter, used: number, limit: number) => Promise<void>; log?: FastifyBaseLogger;
}) {
  const over = new Map<string, UsageMeter[]>();
  const accounts = (await sql<{ id: string }>`select * from accounts_with_limits()`.execute(deps.data.db())).rows;
  for (const { id } of accounts) {
    const q = await deps.quotaFor(id);
    if (!q.usageLimits?.length) continue;
    const hits = await overLimits(deps.data, id, q.usageLimits);
    if (!hits.length) continue;
    for (const h of hits) await deps.onUsageLimit?.(id, h.meter, h.used, h.limit);
    const hard = hits.filter((h) => h.hard);
    if (!hard.length) continue;
    over.set(id, hard.map((h) => h.meter));
    const { watches, online } = await deps.data.withAccount(id, async (s) => ({
      watches: await s.db.selectFrom("watches").select("id").where("status", "=", "active").execute(),
      online: (await s.sources.list()).filter((x) => x.status === "online"),
    }));
    if (hard.some((h) => h.meter === "ai_checks")) for (const w of watches) await deps.bus?.putWatch(id, w.id, null);
    if (hard.some((h) => isIngestMeter(h.meter))) {
      for (const src of online) {
        await deps.media?.disconnect?.(src.id, "allowance_exhausted");
        await deps.media?.stopFeed?.(id, src.id, "allowance_exhausted");
      }
    }
    if (hard.some((h) => h.meter === "live_view_minutes")) await closeViewers(deps.data, deps.media, id, "allowance_exhausted");
    deps.log?.info({ account: id, over: hard }, "usage allowance exhausted");
  }
  return over;
}
