// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Live view (ADR 0042, amended by ADR 0049). The API checks grants and the
// quota provider, ensures the camera's room, issues a single-use,
// subscribe-only media token and records a session. Everything about a
// viewer after that is the API's too: the media plane's room events say when
// it joined and left; the console says it is still watching (keepalive); the
// sweeper ends idle viewers and viewers of a camera that went away, by
// removing the participant with the reason, and meters `live_view_ms` usage
// per source and UTC day (`live_view_minutes` in GET /v1/usage).
import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { sql } from "kysely";
import { canSense } from "../access.js";
import type { DataAccess } from "../data/access.js";
import { ApiError } from "../errors.js";
import type { IngestSigner } from "../ingest.js";
import type { MediaControl } from "../media-driver.js";
import type { AuditLog, Quota } from "../module.js";

export interface LiveDeps {
  data: DataAccess;
  signer: IngestSigner;
  media?: MediaControl;
  audit: AuditLog;
  quotaFor(accountId: string): Promise<Quota>;
  /** Used and limit when the account is over a hard `live_view_minutes` allowance. */
  overAllowance(accountId: string): Promise<{ used: number; limit: number } | undefined>;
  /** Viewers who show no sign of life for this long are closed. */
  idleTimeoutSeconds: number;
  /** Lifetime of the viewer's join token (it must be used within this time). */
  tokenTtlSeconds: number;
  /** Viewers per camera (MEDIA_MAX_VIEWERS_PER_SOURCE). */
  maxViewersPerSource?: number;
}

const newSessionId = () => `lv_${randomBytes(15).toString("base64url")}`;

/** Sessions counted against `max_live_viewers`: watching now, or issued and not yet joined. */
export async function openViewers(data: DataAccess, accountId: string, sourceId?: string): Promise<number> {
  const row = await data.withAccount(accountId, (s) => {
    let q = s.db.selectFrom("live_sessions").select(sql<string>`count(*)`.as("n"))
      .where("ended_at", "is", null)
      .where((eb) => eb.or([eb("joined_at", "is not", null), eb("expires_at", ">", new Date())]));
    if (sourceId) q = q.where("source_id", "=", sourceId);
    return q.executeTakeFirstOrThrow();
  });
  return Number(row.n);
}

export function registerLiveRoutes(app: FastifyInstance, deps: LiveDeps) {
  app.post<{ Params: { id: string }; Body: { audio?: boolean } | undefined }>(
    "/v1/sources/:id/live",
    { schema: { body: { type: ["object", "null"], additionalProperties: false, properties: { audio: { type: "boolean" } } } } },
    async (req) => {
      const accountId = req.accountId!;
      const source = await deps.data.withAccount(accountId, (s) => s.sources.get(req.params.id));
      if (!source) throw new ApiError(404, "not_found", "source not found");
      if (source.type === "sensor") throw new ApiError(409, "conflict", "this source has no video to watch");
      // A video grant is required (checkRoute); audio needs its own grant as well as `audio: true`.
      const wantsAudio = req.body?.audio === true;
      if (wantsAudio && !canSense(req, source.id, "audio")) throw new ApiError(403, "forbidden_sense", "this agent has no audio grant for this source");
      const quota = await deps.quotaFor(accountId);
      if (quota.liveView === false) throw new ApiError(403, "feature_not_available", "Live view isn't available on this account.", { feature: "live_view" });
      const over = await deps.overAllowance(accountId);
      if (over) {
        throw new ApiError(429, "limit_reached", "This account has used its live view minutes for now.", { limit: "live_view_minutes", used: over.used, max: over.limit });
      }
      if (!deps.media?.liveState) throw new ApiError(503, "service_unavailable", "live view needs the media plane");
      const max = quota.maxLiveViewers ?? null;
      if (max !== null && (await openViewers(deps.data, accountId)) >= max) {
        throw new ApiError(429, "limit_reached", `At most ${max} people can watch live at once on this account.`, { limit: "max_live_viewers", max });
      }
      const perSource = deps.maxViewersPerSource ?? 50;
      if ((await openViewers(deps.data, accountId, source.id)) >= perSource) {
        throw new ApiError(429, "limit_reached", `At most ${perSource} people can watch this camera at once.`, { limit: "max_viewers_per_source", max: perSource });
      }
      const media = await deps.media.liveState(accountId, source);
      if (!media.streaming) throw new ApiError(409, "conflict", `${source.name} isn't streaming right now`);
      const audio = wantsAudio && source.record_audio;
      const sessionId = newSessionId();
      const { token, expiresAt } = await deps.signer.signViewer(
        { accountId, sourceId: source.id, sessionId, audio, idleTimeoutSeconds: deps.idleTimeoutSeconds, maxLiveViewers: max },
        deps.tokenTtlSeconds,
      );
      await deps.data.withAccount(accountId, (s) =>
        s.db.insertInto("live_sessions").values({ id: sessionId, account_id: accountId, source_id: source.id, actor: req.access?.actor ?? "unknown", audio, expires_at: expiresAt }).execute());
      // Watching someone live is audited on its own line, not only as a request.
      await deps.audit.write({ accountId, actor: req.access?.actor ?? "unknown", action: "live.start", target: source.id, status: 200, details: { session_id: sessionId, audio } });
      return {
        session_id: sessionId, media_url: media.signalUrl, token, expires_at: expiresAt.toISOString(),
        idle_timeout_seconds: deps.idleTimeoutSeconds, audio,
      };
    },
  );

  // The viewer is still there (the console sends it on user activity, never on a timer alone).
  app.post<{ Params: { session: string } }>("/v1/live/:session/keepalive", async (req) => {
    const row = await deps.data.withAccount(req.accountId!, (s) =>
      s.db.updateTable("live_sessions").set({ last_seen_at: new Date() }).where("id", "=", req.params.session).where("ended_at", "is", null)
        .returning(["id"]).executeTakeFirst());
    if (!row) throw new ApiError(404, "not_found", "no such live session (it may have ended)");
    return { idle_timeout_seconds: deps.idleTimeoutSeconds };
  });
}

const DAY = 86400_000;

/** Writes viewing time up to `until` (split at UTC midnight) and moves `metered_until`. Idempotent per tick. */
export async function meter(data: DataAccess, accountId: string, sessionId: string, until: Date) {
  await data.withAccount(accountId, async (s) => {
    const row = await s.db.selectFrom("live_sessions").select(["source_id", "joined_at", "metered_until"]).where("id", "=", sessionId).forUpdate().executeTakeFirst();
    const from = row?.metered_until ?? row?.joined_at;
    if (!row || !from || until.getTime() <= new Date(from).getTime()) return;
    let start = new Date(from).getTime();
    const end = until.getTime();
    while (start < end) {
      const cut = Math.min(end, Math.floor(start / DAY) * DAY + DAY);
      await s.db.insertInto("usage_records").values({
        account_id: accountId, source_id: row.source_id, kind: "live_view_ms", quantity: cut - start, at: new Date(start), dedupe_key: `live:${sessionId}:${cut}`,
      }).onConflict((oc) => oc.columns(["account_id", "dedupe_key"]).where("dedupe_key", "is not", null).doNothing()).execute();
      start = cut;
    }
    await s.db.updateTable("live_sessions").set({ metered_until: until }).where("id", "=", sessionId).execute();
  });
}

export async function endSession(data: DataAccess, accountId: string, sessionId: string, at: Date, reason: string) {
  await meter(data, accountId, sessionId, at);
  await data.withAccount(accountId, (s) =>
    s.db.updateTable("live_sessions").set({ ended_at: at, end_reason: reason.slice(0, 64) }).where("id", "=", sessionId).where("ended_at", "is", null).execute());
}

/** A viewer's participant.joined / participant.left room event (spec/media/callbacks.json). Idempotent. */
export async function handleViewerEvent(data: DataAccess, accountId: string, event: "joined" | "left", sessionId: string, at: Date, reason?: string) {
  if (event === "joined") {
    await data.withAccount(accountId, (s) =>
      s.db.updateTable("live_sessions").set({ joined_at: at, last_seen_at: at, metered_until: at })
        .where("id", "=", sessionId).where("joined_at", "is", null).where("ended_at", "is", null).execute());
  } else {
    await endSession(data, accountId, sessionId, at, reason ?? "left");
  }
}

/**
 * The live view sweep: meters every viewer up to now, ends viewers idle past
 * the timeout and viewers of a camera that has been gone for the grace
 * period (removing the participant with the reason), and closes tokens never
 * used.
 */
export async function sweepLiveSessions(
  data: DataAccess,
  opts: { idleTimeoutSeconds: number; offlineGraceSeconds?: number; media?: MediaControl; log?: FastifyBaseLogger; now?: Date } = { idleTimeoutSeconds: 600 },
) {
  const now = opts.now ?? new Date();
  let ended = 0;
  const open = (await sql<{ account_id: string; id: string; source_id: string; last_seen_at: Date | null; joined_at: Date; source_status: string; source_status_since: Date | null }>`
    select * from open_live_sessions()`.execute(data.db())).rows;
  for (const r of open) {
    const lastSeen = new Date(r.last_seen_at ?? r.joined_at).getTime();
    const offlineFor = r.source_status !== "online" && r.source_status_since ? now.getTime() - new Date(r.source_status_since).getTime() : 0;
    const reason = now.getTime() - lastSeen > opts.idleTimeoutSeconds * 1000 ? "idle"
      : offlineFor > (opts.offlineGraceSeconds ?? 30) * 1000 ? "source_offline" : undefined;
    if (reason) {
      await opts.media?.removeViewer?.(r.source_id, r.id, reason);
      await endSession(data, r.account_id, r.id, now, reason);
      ended++;
    } else {
      await meter(data, r.account_id, r.id, now);
    }
  }
  // Tokens issued and never used.
  const stale = (await sql<{ account_id: string; id: string }>`select * from stale_live_sessions(${new Date(0)})`.execute(data.db())).rows;
  for (const r of stale) {
    const s = await data.withAccount(r.account_id, (x) => x.db.selectFrom("live_sessions").selectAll().where("id", "=", r.id).executeTakeFirst());
    if (!s || s.joined_at) continue;
    await data.withAccount(r.account_id, (x) => x.db.updateTable("live_sessions").set({ ended_at: s.expires_at, end_reason: "not_joined" }).where("id", "=", r.id).execute());
    ended++;
  }
  if (ended) opts.log?.info({ ended }, "live sessions ended by the sweep");
  return ended;
}

/** Ends an account's live viewers (allowance used up, access revoked). Returns how many. */
export async function closeViewers(data: DataAccess, media: MediaControl | undefined, accountId: string, reason: string, filter: { sourceId?: string; sessionId?: string } = {}) {
  const rows = await data.withAccount(accountId, (s) => {
    let q = s.db.selectFrom("live_sessions").select(["id", "source_id"]).where("ended_at", "is", null);
    if (filter.sourceId) q = q.where("source_id", "=", filter.sourceId);
    if (filter.sessionId) q = q.where("id", "=", filter.sessionId);
    return q.execute();
  });
  for (const r of rows) {
    await media?.removeViewer?.(r.source_id, r.id, reason);
    await endSession(data, accountId, r.id, new Date(), reason);
  }
  return rows.length;
}
