// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { requireRange, seesSource } from "../access.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Selectable, sql } from "kysely";
import type { AccountScope, DataAccess } from "../data/access.js";
import { newId } from "../data/ids.js";
import type { ClipsTable } from "../data/schema.js";
import { ApiError } from "../errors.js";
import { type KeyRefSealer, type MediaClaims, type PlaybackScope, type PlaybackSigner, PlaybackTokenError, buildPlaylist } from "../playback.js";
import type { ObjectStorage } from "../storage.js";
import { audioTrackIds, stripAudioInit, stripTracksFromSegment } from "../fmp4.js";
import { type MediaGuard, mediaClaims } from "../media-access.js";

/** Presigned object URLs live only long enough for the player to follow the redirect (ADR 0036). */
const PRESIGN_SECONDS = 60;

async function readAll(body: ReadableStream | NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

export interface PlaybackDeps {
  data: DataAccess;
  storage: ObjectStorage;
  signer: PlaybackSigner;
  apiPublicUrl?: string;
  ttlSeconds: number;
  /** Latest JPEG for a source (brain snapshot KV), if available. */
  latestSnapshot?: (accountId: string, sourceId: string) => Promise<Uint8Array | undefined>;
  /** Seals the caller's key into media links, and re-checks it on every media request (ADR 0036). */
  keyRefs?: KeyRefSealer;
  guard?: MediaGuard;
}

const MAX_PLAYLIST_MS = 24 * 3600_000;
const MAX_CLIP_MS = 3600_000;
const GAP_MS = 1500;

const parseTime = (v: unknown, name: string): number => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  if (Number.isNaN(t)) throw new ApiError(400, "validation_failed", `${name} must be an RFC 3339 time`);
  return t;
};

/** Segments overlapping [from, to), oldest first. */
function segmentsIn(s: AccountScope, sourceId: string, from: number, to: number) {
  return s.db
    .selectFrom("segments")
    .select(["id", "key", "init_key", "start_at", "duration_ms", "bytes"])
    .where("source_id", "=", sourceId)
    .where("start_at", "<", new Date(to))
    .where(sql<boolean>`start_at + duration_ms * interval '1 millisecond' > ${new Date(from)}`)
    .orderBy("start_at")
    .execute();
}

/** Continuous recorded ranges (gaps-and-islands in SQL, so 7 days of segments never leave the database). */
async function recordedRanges(s: AccountScope, sourceId: string, from: number, to: number) {
  const { rows } = await sql<{ from: Date; to: Date }>`
    select min(start_at) as "from", max(end_at) as "to" from (
      select start_at, end_at,
        sum(case when prev_end is null or start_at - prev_end > ${`${GAP_MS} milliseconds`}::interval then 1 else 0 end)
          over (order by start_at) as grp
      from (
        select start_at, start_at + duration_ms * interval '1 millisecond' as end_at,
          lag(start_at + duration_ms * interval '1 millisecond') over (order by start_at) as prev_end
        from segments
        where source_id = ${sourceId} and start_at < ${new Date(to)}
          and start_at + duration_ms * interval '1 millisecond' > ${new Date(from)}
      ) t
    ) g group by grp order by 1`.execute(s.db);
  return rows.map((r) => ({ from: new Date(r.from), to: new Date(r.to) }));
}

function gapsBetween(ranges: { from: Date; to: Date }[]) {
  const gaps: { from: string; to: string }[] = [];
  for (let i = 1; i < ranges.length; i++) gaps.push({ from: ranges[i - 1]!.to.toISOString(), to: ranges[i]!.from.toISOString() });
  return gaps;
}

export function toClip(row: Selectable<ClipsTable>, playback?: { url: string; expiresAt: Date }) {
  return {
    id: row.id,
    source_id: row.source_id,
    ...(row.title ? { title: row.title } : {}),
    from: new Date(row.from_at).toISOString(),
    to: new Date(row.to_at).toISOString(),
    duration_ms: row.duration_ms,
    bytes: Number(row.bytes),
    ...(playback ? { playback_url: playback.url, playback_expires_at: playback.expiresAt.toISOString() } : {}),
    created_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * Copies the whole segments overlapping [from, to) (no re-encoding) to
 * clips/{account}/{clip}/ and records the clip. Returns undefined if nothing
 * was recorded in the range. Used by POST /v1/clips and the event clip worker.
 */
export async function createClip(
  deps: Pick<PlaybackDeps, "data" | "storage">, accountId: string, sourceId: string, from: number, to: number, title: string | null,
): Promise<Selectable<ClipsTable> | undefined> {
  const clipId = newId("clp");
  const rows = await deps.data.withAccount(accountId, (s) => segmentsIn(s, sourceId, from, to));
  if (!rows.length) return undefined;
  const inits = new Map<string, string>();
  const copies = rows.map((r, seq) => {
    if (!inits.has(r.init_key)) inits.set(r.init_key, `clips/${accountId}/${clipId}/init-${inits.size}.mp4`);
    return { seq, from: r.key, key: `clips/${accountId}/${clipId}/${String(seq).padStart(5, "0")}.m4s`, init_key: inits.get(r.init_key)!, r };
  });
  const jobs = [...[...inits].map(([fromKey, toKey]) => [fromKey, toKey] as const), ...copies.map((c) => [c.from, c.key] as const)];
  for (let i = 0; i < jobs.length; i += 16) await Promise.all(jobs.slice(i, i + 16).map(([a, b]) => deps.storage.copy(a, b)));
  const first = rows[0]!;
  const last = rows.at(-1)!;
  return deps.data.withAccount(accountId, async (s) => {
    const row = await s.db
      .insertInto("clips")
      .values({
        id: clipId, account_id: accountId, source_id: sourceId, title,
        from_at: new Date(first.start_at), to_at: new Date(new Date(last.start_at).getTime() + last.duration_ms),
        duration_ms: rows.reduce((a, r) => a + r.duration_ms, 0), bytes: rows.reduce((a, r) => a + Number(r.bytes), 0),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await s.db
      .insertInto("clip_segments")
      .values(copies.map((c) => ({
        clip_id: clipId, seq: c.seq, account_id: accountId, key: c.key, init_key: c.init_key,
        start_at: new Date(c.r.start_at), duration_ms: c.r.duration_ms,
      })))
      .execute();
    return row;
  });
}

export function registerPlaybackRoutes(app: FastifyInstance, deps: PlaybackDeps) {
  const base = (req: { protocol: string; host: string }) => deps.apiPublicUrl ?? `${req.protocol}://${req.host}`;
  const playbackUrl = (req: { protocol: string; host: string }, scope: PlaybackScope) => {
    const { token, expiresAt } = deps.signer.sign(scope, deps.ttlSeconds);
    return { url: `${base(req)}/playback/${token}/index.m3u8`, expiresAt };
  };
  /** The caller's claims for [from, to] on a source; throws when it has no video grant there. */
  const claimsFor = (req: FastifyRequest, sourceId: string, from: number, to: number): MediaClaims => {
    if (!deps.keyRefs) return {};
    const c = mediaClaims(req, deps.keyRefs, sourceId, from, to);
    if (!c) throw new ApiError(403, "forbidden_sense", "this agent has no video grant covering that range");
    return c;
  };
  const visibleClip = (req: FastifyRequest, r: { source_id: string; from_at: Date | string; to_at: Date | string }) =>
    !deps.keyRefs || mediaClaims(req, deps.keyRefs, r.source_id, new Date(r.from_at).getTime(), new Date(r.to_at).getTime()) !== null;

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/v1/sources/:id/timeline", async (req) => {
    const to = req.query.to ? parseTime(req.query.to, "to") : Date.now();
    const from = req.query.from ? parseTime(req.query.from, "from") : to - 24 * 3600_000;
    if (from >= to) throw new ApiError(400, "validation_failed", "from must be before to");
    return deps.data.withAccount(req.accountId!, async (s) => {
      const source = await s.sources.get(req.params.id);
      if (!source) throw new ApiError(404, "not_found", "source not found");
      const account = await s.account.get();
      const ranges = await recordedRanges(s, source.id, from, to);
      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        recorded: ranges.map((r) => ({ from: r.from.toISOString(), to: r.to.toISOString() })),
        gaps: gapsBetween(ranges),
        retention_days: source.retention_days ?? account!.retention_days,
      };
    });
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/v1/sources/:id/playback", async (req) => {
    const from = parseTime(req.query.from, "from");
    const to = parseTime(req.query.to, "to");
    if (from >= to) throw new ApiError(400, "validation_failed", "from must be before to");
    if (to - from > MAX_PLAYLIST_MS) throw new ApiError(400, "validation_failed", "a playlist covers at most 24 hours");
    const accountId = req.accountId!;
    const ranges = await deps.data.withAccount(accountId, async (s) => {
      if (!(await s.sources.get(req.params.id))) throw new ApiError(404, "not_found", "source not found");
      return recordedRanges(s, req.params.id, from, to);
    });
    if (!ranges.length) throw new ApiError(404, "not_found", "nothing was recorded in that range");
    const claims = claimsFor(req, req.params.id, from, to);
    const { url, expiresAt } = playbackUrl(req, { kind: "range", accountId, sourceId: req.params.id, from, to, ...claims });
    return { url, expires_at: expiresAt.toISOString(), gaps: gapsBetween(ranges) };
  });

  // --- Signed HLS (no API key: the token is the credential) -------------------
  const verifyToken = (token: string): PlaybackScope => {
    try {
      return deps.signer.verify(token);
    } catch (e) {
      throw new ApiError(e instanceof PlaybackTokenError && e.message === "expired" ? 403 : 401, "unauthorized", "playback link is invalid or expired");
    }
  };
  /** Verifies the token, then re-checks the issuing key and its grants (revocation reaches media, ADR 0036). */
  const authorize = async (token: string) => {
    const scope = verifyToken(token);
    const decision = deps.guard ? await deps.guard(scope) : { stripAudio: Boolean(scope.na) };
    return { scope, ...decision };
  };

  app.get<{ Params: { token: string } }>("/playback/:token/index.m3u8", async (req, reply) => {
    const { scope } = await authorize(req.params.token);
    const segments = await deps.data.withAccount(scope.accountId, async (s) => {
      if (scope.kind === "range") {
        const rows = await segmentsIn(s, scope.sourceId, scope.from, scope.to);
        // Each init is addressed by the first segment that uses it.
        const initRef = new Map<string, string>();
        return rows.map((r) => {
          if (!initRef.has(r.init_key)) initRef.set(r.init_key, String(r.id));
          return { ref: String(r.id), initRef: initRef.get(r.init_key)!, start: new Date(r.start_at), durationMs: r.duration_ms };
        });
      }
      if (scope.kind !== "clip") return [];
      const rows = await s.db.selectFrom("clip_segments").selectAll().where("clip_id", "=", scope.clipId).orderBy("seq").execute();
      const initRef = new Map<string, string>();
      return rows.map((r) => {
        if (!initRef.has(r.init_key)) initRef.set(r.init_key, String(r.seq));
        return { ref: String(r.seq), initRef: initRef.get(r.init_key)!, start: new Date(r.start_at), durationMs: r.duration_ms };
      });
    });
    if (!segments.length) throw new ApiError(404, "not_found", "no recording in this range any more");
    reply.header("content-type", "application/vnd.apple.mpegurl").header("cache-control", "private, max-age=5");
    return buildPlaylist(segments);
  });

  const deliver = async (reply: FastifyReply, key: string, contentType: string) => {
    const signed = await deps.storage.presign(key, PRESIGN_SECONDS);
    if (signed) return reply.redirect(signed, 302);
    const obj = await deps.storage.get(key);
    reply.header("content-type", contentType).header("cache-control", "private, max-age=3600");
    if (obj.length) reply.header("content-length", obj.length);
    return reply.send(obj.body);
  };

  // Audio removal for video-only grants (ADR 0037): always streamed through the API, never redirected.
  const audioIds = new Map<string, Set<number>>();
  const audioTracksOf = async (initKey: string) => {
    let ids = audioIds.get(initKey);
    if (!ids) {
      ids = audioTrackIds(await readAll((await deps.storage.get(initKey)).body));
      if (audioIds.size > 2000) audioIds.clear();
      audioIds.set(initKey, ids);
    }
    return ids;
  };
  const deliverWithoutAudio = async (reply: FastifyReply, key: string, initKey: string, isInit: boolean) => {
    const raw = await readAll((await deps.storage.get(key)).body);
    const body = isInit ? stripAudioInit(raw) : stripTracksFromSegment(raw, await audioTracksOf(initKey));
    return reply
      .header("content-type", isInit ? "video/mp4" : "video/iso.segment")
      .header("cache-control", "private, no-store")
      .header("content-length", body.length)
      .send(body);
  };

  const lookup = async (scope: PlaybackScope, ref: string) =>
    deps.data.withAccount(scope.accountId, async (s) => {
      if (scope.kind === "range") {
        if (!/^\d+$/.test(ref)) return undefined;
        const r = await s.db.selectFrom("segments").select(["key", "init_key", "source_id", "start_at", "duration_ms"]).where("id", "=", ref).executeTakeFirst();
        if (!r || r.source_id !== scope.sourceId) return undefined;
        const start = new Date(r.start_at).getTime();
        if (start >= scope.to || start + r.duration_ms <= scope.from) return undefined;
        return r;
      }
      if (scope.kind !== "clip") return undefined;
      return s.db.selectFrom("clip_segments").select(["key", "init_key"]).where("clip_id", "=", scope.clipId).where("seq", "=", Number(ref)).executeTakeFirst();
    });

  app.get<{ Params: { token: string; ref: string } }>("/playback/:token/s/:ref", async (req, reply) => {
    const { scope, stripAudio } = await authorize(req.params.token);
    const row = await lookup(scope, req.params.ref.replace(/\.m4s$/, ""));
    if (!row) throw new ApiError(404, "not_found", "segment not found");
    if (stripAudio) return deliverWithoutAudio(reply, row.key, row.init_key, false);
    return deliver(reply, row.key, "video/iso.segment");
  });
  app.get<{ Params: { token: string; ref: string } }>("/playback/:token/i/:ref", async (req, reply) => {
    const { scope, stripAudio } = await authorize(req.params.token);
    const row = await lookup(scope, req.params.ref.replace(/\.mp4$/, ""));
    if (!row) throw new ApiError(404, "not_found", "init segment not found");
    if (stripAudio) return deliverWithoutAudio(reply, row.init_key, row.init_key, true);
    return deliver(reply, row.init_key, "video/mp4");
  });

  // Signed media objects (event snapshots) and a source's latest snapshot.
  app.get<{ Params: { token: string } }>("/media/:token/snapshot.jpg", async (req, reply) => {
    const { scope } = await authorize(req.params.token);
    if (scope.kind === "object") return deliver(reply, scope.key, "image/jpeg");
    if (scope.kind === "latest" && deps.latestSnapshot) {
      const jpeg = await deps.latestSnapshot(scope.accountId, scope.sourceId);
      if (!jpeg) throw new ApiError(404, "not_found", "no snapshot yet");
      return reply.header("content-type", "image/jpeg").header("cache-control", "private, max-age=5").send(jpeg);
    }
    throw new ApiError(404, "not_found", "not a snapshot link");
  });

  app.get<{ Params: { token: string } }>("/media/:token/export.json", async (req, reply) => {
    const { scope } = await authorize(req.params.token);
    if (scope.kind === "object" && scope.key.startsWith(`exports/${scope.accountId}/`)) {
      reply.header("content-disposition", 'attachment; filename="senseplane-export.json"');
      return deliver(reply, scope.key, "application/json");
    }
    throw new ApiError(404, "not_found", "not an export link");
  });

  // --- Clips -------------------------------------------------------------------
  app.post<{ Body: { source: string; from: string; to: string; title?: string } }>(
    "/v1/clips",
    {
      schema: {
        body: {
          type: "object", additionalProperties: false, required: ["source", "from", "to"],
          properties: { source: { type: "string" }, from: { type: "string" }, to: { type: "string" }, title: { type: "string", maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const from = parseTime(req.body.from, "from");
      const to = parseTime(req.body.to, "to");
      if (from >= to) throw new ApiError(400, "validation_failed", "from must be before to");
      if (to - from > MAX_CLIP_MS) throw new ApiError(400, "validation_failed", "a clip is at most 1 hour");
      const accountId = req.accountId!;
      requireRange(req, req.body.source, "video", new Date(from), new Date(to));
      if (!(await deps.data.withAccount(accountId, (s) => s.sources.get(req.body.source)))) throw new ApiError(404, "not_found", "source not found");
      const clip = await createClip(deps, accountId, req.body.source, from, to, req.body.title ?? null);
      if (!clip) throw new ApiError(404, "not_found", "nothing was recorded in that range");
      const clipId = clip.id;
      const claims = claimsFor(req, clip.source_id, new Date(clip.from_at).getTime(), new Date(clip.to_at).getTime());
      return reply.code(201).send(toClip(clip, playbackUrl(req, { kind: "clip", accountId, clipId, ...claims })));
    },
  );

  // Agents only see clips whose whole range sits inside one of their video grants.
  app.get("/v1/clips", async (req) => {
    const rows = await deps.data.withAccount(req.accountId!, (s) => s.db.selectFrom("clips").selectAll().orderBy("created_at", "desc").execute());
    return { data: rows.filter((r) => seesSource(req, r.source_id) && visibleClip(req, r)).map((r) => toClip(r)), next_cursor: null };
  });

  app.get<{ Params: { id: string } }>("/v1/clips/:id", async (req) => {
    const row = await deps.data.withAccount(req.accountId!, (s) => s.db.selectFrom("clips").selectAll().where("id", "=", req.params.id).executeTakeFirst());
    if (!row || !seesSource(req, row.source_id) || !visibleClip(req, row)) throw new ApiError(404, "not_found", "clip not found");
    const claims = claimsFor(req, row.source_id, new Date(row.from_at).getTime(), new Date(row.to_at).getTime());
    return toClip(row, playbackUrl(req, { kind: "clip", accountId: req.accountId!, clipId: row.id, ...claims }));
  });

  app.delete<{ Params: { id: string } }>("/v1/clips/:id", async (req, reply) => {
    const keys = await deps.data.withAccount(req.accountId!, async (s) => {
      const segs = await s.db.selectFrom("clip_segments").select(["key", "init_key"]).where("clip_id", "=", req.params.id).execute();
      const deleted = await s.db.deleteFrom("clips").where("id", "=", req.params.id).executeTakeFirst();
      if (!deleted.numDeletedRows) throw new ApiError(404, "not_found", "clip not found");
      return [...new Set(segs.flatMap((x) => [x.key, x.init_key]))];
    });
    await deps.storage.deleteMany(keys);
    return reply.code(204).send();
  });
}
