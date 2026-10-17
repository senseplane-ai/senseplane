// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Grants and revocation for signed media links (ADR 0036).
//
// Media links (HLS playback, clips, snapshots) are bearer URLs so players can
// fetch them without headers. Each link issued to an API key carries that key's
// sealed hash; every media request re-checks, with a short cache, that the key
// still exists, that its agent still has a video grant covering the link's
// source and time, and whether audio may be served. Revoking a key or a grant
// therefore reaches media within the cache window (30 s), not the link's TTL.
import type { FastifyRequest } from "fastify";
import { type Grant, sensesForRange } from "./access.js";
import type { DataAccess } from "./data/access.js";
import { ApiError } from "./errors.js";
import type { KeyRefSealer, MediaClaims, PlaybackScope } from "./playback.js";

/** Claims for a media link about [from, to] on a source; null when the caller may not see that video. */
export function mediaClaims(req: Pick<FastifyRequest, "access">, sealer: KeyRefSealer, sourceId: string, from: number, to: number): MediaClaims | null {
  const access = req.access;
  if (!access) return {};
  const senses = sensesForRange(access.grants, sourceId, new Date(from), new Date(to));
  if (senses !== "all" && !senses.has("video")) return null;
  return {
    ...(access.keyHash ? { kr: sealer.seal(access.keyHash) } : {}),
    ...(senses !== "all" && !senses.has("audio") ? { na: 1 as const } : {}),
    sid: sourceId,
    f: from,
    t: to,
  };
}

export interface MediaDecision {
  /** Serve video without its audio track. */
  stripAudio: boolean;
}

export function createMediaGuard(data: DataAccess, sealer: KeyRefSealer, cacheMs = 30_000) {
  const principals = new Map<string, { at: number; value: { accountId: string; agentId: string | null } | undefined }>();
  const grantsCache = new Map<string, { at: number; value: Grant[] }>();
  const fresh = (at: number) => Date.now() - at < cacheMs;

  const principal = async (keyHash: string) => {
    const hit = principals.get(keyHash);
    if (hit && fresh(hit.at)) return hit.value;
    const value = await data.principalForKeyHash(keyHash);
    principals.set(keyHash, { at: Date.now(), value });
    return value;
  };
  const grantsOf = async (accountId: string, agentId: string) => {
    const hit = grantsCache.get(agentId);
    if (hit && fresh(hit.at)) return hit.value;
    const value = await data.withAccount(accountId, (s) =>
      s.db.selectFrom("grants").select(["source_ids", "senses", "window_from", "window_to"]).where("agent_id", "=", agentId).execute());
    grantsCache.set(agentId, { at: Date.now(), value });
    return value;
  };

  /** Throws when the link's key or grants no longer allow it; otherwise says whether to strip audio. */
  return async function check(scope: PlaybackScope): Promise<MediaDecision> {
    if (!scope.kr) return { stripAudio: Boolean(scope.na) };
    const keyHash = sealer.open(scope.kr);
    const who = keyHash ? await principal(keyHash) : undefined;
    if (!who || who.accountId !== scope.accountId) throw new ApiError(401, "unauthorized", "this media link's access was revoked");
    if (!who.agentId) return { stripAudio: Boolean(scope.na) };
    if (!scope.sid) throw new ApiError(403, "forbidden_sense", "this media link has no source scope");
    const now = Date.now();
    const senses = sensesForRange(await grantsOf(scope.accountId, who.agentId), scope.sid, new Date(scope.f ?? now), new Date(scope.t ?? now));
    if (senses !== "all" && !senses.has("video")) throw new ApiError(403, "forbidden_sense", "this agent no longer has a video grant for this media");
    return { stripAudio: Boolean(scope.na) || (senses !== "all" && !senses.has("audio")) };
  };
}

export type MediaGuard = ReturnType<typeof createMediaGuard>;
