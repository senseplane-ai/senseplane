// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { DataAccess } from "../data/access.js";
import { ApiError } from "../errors.js";
import type { Quota, UsageMeter } from "../module.js";

/**
 * The account's limits as the console shows them, all from the quota provider
 * (null = unlimited; the self-host default is everything enabled and unlimited).
 * Usage allowances are the monthly `usageLimits` entry for a meter, else its daily one.
 */
export function accountLimits(q: Quota) {
  const pick = (meter: UsageMeter) => {
    const ls = (q.usageLimits ?? []).filter((l) => l.meter === meter);
    return (ls.find((l) => l.period === "month") ?? ls[0])?.limit ?? null;
  };
  return {
    live_view: q.liveView !== false,
    live_view_minutes: pick("live_view_minutes"),
    max_live_viewers: q.maxLiveViewers ?? null,
    camera_minutes: pick("camera_minutes"),
    storage_gb: pick("storage_gb") ?? (q.storageCapBytes ? Math.round((q.storageCapBytes / 1e9) * 1000) / 1000 : null),
    ai_checks: pick("ai_checks"),
  };
}

/** Stored bytes and recent raw growth, for "≈ X days at current usage" (ADR 0032). */
export async function storageSummary(data: DataAccess, accountId: string, sourceId?: string) {
  return data.withAccount(accountId, async (s) => {
    const seg = s.db.selectFrom("segments");
    const scoped = sourceId ? seg.where("source_id", "=", sourceId) : seg;
    const raw = await scoped.select(sql<string>`coalesce(sum(bytes), 0)`.as("b")).executeTakeFirstOrThrow();
    const week = await scoped.select([sql<string>`coalesce(sum(bytes), 0)`.as("b"), sql<string | null>`min(start_at)`.as("first")])
      .where("start_at", ">", new Date(Date.now() - 7 * 86400_000)).executeTakeFirstOrThrow();
    const clipsQ = s.db.selectFrom("clips").select(sql<string>`coalesce(sum(bytes), 0)`.as("b"));
    const snapsQ = s.db.selectFrom("events").select(sql<string>`coalesce(sum(snapshot_bytes), 0)`.as("b"));
    const clips = await (sourceId ? clipsQ.where("source_id", "=", sourceId) : clipsQ).executeTakeFirstOrThrow();
    const snaps = await (sourceId ? snapsQ.where("source_id", "=", sourceId) : snapsQ).executeTakeFirstOrThrow();
    const days = week.first ? Math.max(1 / 24, (Date.now() - new Date(week.first).getTime()) / 86400_000) : 0;
    return { raw_bytes: Number(raw.b), clip_bytes: Number(clips.b), snapshot_bytes: Number(snaps.b), raw_bytes_per_day: days ? Math.round(Number(week.b) / days) : 0 };
  });
}

/** "≈ X days at current usage" for a byte cap, or null when there is no cap or no recent recording. */
export const estimatedDays = (capBytes: number | null | undefined, keptBytes: number, perDay: number) =>
  capBytes == null || !perDay ? null : Math.max(0, Math.round(((capBytes - keptBytes) / perDay) * 10) / 10);

/** True for IANA zone names the runtime knows (ADR 0044). */
export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function registerAccountRoutes(
  app: FastifyInstance,
  deps: {
    data: DataAccess; maxRetentionDays(accountId: string): Promise<number | null>; storageCap(accountId: string): Promise<number | null | undefined>;
    quotaFor?(accountId: string): Promise<Quota>;
  },
) {
  const show = async (accountId: string) => {
    const row = await deps.data.withAccount(accountId, (s) => s.account.get());
    if (!row) throw new ApiError(404, "not_found", "account not found");
    const storage = await storageSummary(deps.data, accountId);
    const ownCap = row.retention_max_bytes == null ? null : Number(row.retention_max_bytes);
    const cap = ownCap ?? (await deps.storageCap(accountId)) ?? null;
    return {
      id: row.id,
      name: row.name,
      time_zone: row.time_zone,
      retention_mode: row.retention_mode,
      retention_days: row.retention_days,
      retention_max_bytes: ownCap,
      retention_max_days: await deps.maxRetentionDays(accountId),
      storage: {
        ...storage,
        storage_cap_bytes: cap,
        estimated_days: row.retention_mode === "fill" ? estimatedDays(cap, storage.clip_bytes + storage.snapshot_bytes, storage.raw_bytes_per_day) : row.retention_days,
      },
      created_at: new Date(row.created_at).toISOString(),
      ...(deps.quotaFor ? await deps.quotaFor(accountId).then((q) => ({ limits: accountLimits(q), plan_label: q.planLabel ?? null })) : {}),
    };
  };

  app.get("/v1/account", async (req) => show(req.accountId!));

  app.patch<{ Body: { name?: string; time_zone?: string; retention_days?: number | null; retention_mode?: "days" | "fill"; retention_max_bytes?: number | null } }>(
    "/v1/account",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            time_zone: { type: "string", minLength: 1, maxLength: 64 },
            retention_days: { type: ["integer", "null"], minimum: 1 },
            retention_mode: { type: "string", enum: ["days", "fill"] },
            retention_max_bytes: { type: ["integer", "null"], minimum: 1 },
          },
        },
      },
    },
    async (req) => {
      const accountId = req.accountId!;
      const b = req.body;
      if (b.time_zone !== undefined && !validTimeZone(b.time_zone)) {
        throw new ApiError(400, "validation_failed", "time_zone must be an IANA time zone such as Europe/Berlin or UTC");
      }
      const max = await deps.maxRetentionDays(accountId);
      if ("retention_days" in b && max !== null && (b.retention_days === null || b.retention_days! > max)) {
        throw new ApiError(403, "quota_exceeded", `retention_days is limited to ${max} for this account`, { max });
      }
      const current = await deps.data.withAccount(accountId, (s) => s.account.get());
      const mode = b.retention_mode ?? current!.retention_mode;
      const capBytes = "retention_max_bytes" in b ? b.retention_max_bytes : current!.retention_max_bytes;
      if (mode === "fill" && capBytes == null && (await deps.storageCap(accountId)) == null) {
        throw new ApiError(400, "validation_failed", "fill mode needs retention_max_bytes on this instance");
      }
      await deps.data.withAccount(accountId, (s) =>
        s.db
          .updateTable("accounts")
          .set({
            ...(b.name ? { name: b.name } : {}),
            ...(b.time_zone ? { time_zone: b.time_zone } : {}),
            ...("retention_days" in b ? { retention_days: b.retention_days ?? null } : {}),
            ...(b.retention_mode ? { retention_mode: b.retention_mode } : {}),
            ...("retention_max_bytes" in b ? { retention_max_bytes: b.retention_max_bytes ?? null } : {}),
          })
          .where("id", "=", accountId)
          .execute(),
      );
      return show(accountId);
    },
  );
}
