// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Following an object or a pet (ADR 0070): POST queues one, GET shows the
// route it found, each visit with a signed link to that stretch of recording.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type FollowDeps, type FollowInput, type FollowRow, createFollow } from "../follow.js";
import { ApiError } from "../errors.js";
import { mediaClaims } from "../media-access.js";
import type { KeyRefSealer, PlaybackSigner } from "../playback.js";

export interface FollowRouteDeps extends FollowDeps {
  signer: PlaybackSigner;
  apiPublicUrl?: string;
  ttlSeconds: number;
  keyRefs?: KeyRefSealer;
}

const BODY = {
  type: "object", additionalProperties: false, required: ["reference", "from", "to"],
  properties: {
    reference: {
      type: "object", additionalProperties: false,
      properties: {
        event: { type: "string" }, source: { type: "string" }, at: { type: "string" },
        box: { type: "array", minItems: 4, maxItems: 4, items: { type: "number", minimum: 0, maximum: 1 } },
        description: { type: "string", minLength: 3, maxLength: 300 },
      },
    },
    from: { type: "string" }, to: { type: "string" },
    sources: { type: "array", items: { type: "string" }, maxItems: 50 },
    make_story: { type: "boolean" },
  },
};

export function registerFollowRoutes(app: FastifyInstance, deps: FollowRouteDeps) {
  const base = (req: { protocol: string; host: string }) => deps.apiPublicUrl ?? `${req.protocol}://${req.host}`;
  /** A visit's stretch of recording, for a caller with video on it. */
  const link = (req: FastifyRequest, sourceId: string, from: number, to: number) => {
    const claims = deps.keyRefs ? mediaClaims(req, deps.keyRefs, sourceId, from, to) : {};
    if (!claims || claims.bo) return undefined;
    const { token, expiresAt } = deps.signer.sign({ kind: "range", accountId: req.accountId!, sourceId, from, to, ...claims }, deps.ttlSeconds);
    return { playback_url: `${base(req)}/playback/${token}/index.m3u8`, playback_expires_at: expiresAt.toISOString() };
  };
  const toFollow = (req: FastifyRequest, row: FollowRow, withLinks: boolean) => {
    const result = visibleResult(req, row);
    return {
      id: row.id,
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      reference: row.reference,
      sources: row.source_ids,
      from: new Date(row.from_at).toISOString(),
      to: new Date(row.to_at).toISOString(),
      make_story: row.make_story,
      ...(row.story_id ? { story_id: row.story_id } : {}),
      ...(result ? {
        result: {
          ...result,
          route: (result.route ?? []).map((v) => ({
            ...v, ...(withLinks ? link(req, v.source_id, Date.parse(v.from) - 2000, Date.parse(v.to) + 3000) ?? {} : {}),
          })),
        },
      } : {}),
      frames_examined: row.frames_examined,
      model_calls: row.model_calls,
      created_at: new Date(row.created_at).toISOString(),
      ...(row.finished_at ? { finished_at: new Date(row.finished_at).toISOString() } : {}),
    };
  };
  type Result = {
    route?: { source_id: string; from: string; to: string }[]; sightings?: { source_id: string; at: string }[];
    cameras?: { source_id: string }[]; handovers?: { from_source: string; to_source: string }[]; gaps?: { from: string; to: string; note: string }[];
  } & Record<string, unknown>;
  /**
   * What the caller may see of the result now: an agent whose grants no longer cover a camera of the follow
   * gets nothing about that camera (no sightings, boxes or times), and gap notes that don't name cameras.
   */
  const visibleResult = (req: FastifyRequest, row: FollowRow): Result | null => {
    const r = row.result as Result | null;
    if (!r || !req.access?.grants) return r;
    const from = new Date(row.from_at).getTime();
    const to = new Date(row.to_at).getTime();
    const ok = new Set(row.source_ids.filter((id) => (deps.keyRefs ? mediaClaims(req, deps.keyRefs, id, from, to) : {}) !== null));
    if (ok.size === row.source_ids.length) return r;
    return {
      ...r,
      route: (r.route ?? []).filter((v) => ok.has(v.source_id)),
      sightings: (r.sightings ?? []).filter((s) => ok.has(s.source_id)),
      cameras: (r.cameras ?? []).filter((x) => ok.has(x.source_id)),
      handovers: (r.handovers ?? []).filter((h) => ok.has(h.from_source) && ok.has(h.to_source)),
      gaps: (r.gaps ?? []).map((g) => ({ ...g, note: g.note.replace(/: .*$/, ": not seen") })),
      first_seen: undefined, last_seen: undefined,
    };
  };
  /** An agent sees the follows it made; people with access to the workspace see them all. */
  const visible = (req: FastifyRequest, row: FollowRow) => !req.access?.agentId || row.created_by_agent === req.access.agentId;

  app.post<{ Body: FollowInput }>("/v1/follows", { schema: { body: BODY } }, async (req, reply) => {
    const row = await createFollow(deps, req, req.body);
    return reply.code(202).send(toFollow(req, row, false));
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/follows", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const rows = await deps.data.withAccount(req.accountId!, (s) => {
      let q = s.db.selectFrom("follows").selectAll().orderBy("created_at", "desc").limit(limit);
      if (req.access?.agentId) q = q.where("created_by_agent", "=", req.access.agentId);
      return q.execute();
    });
    return { data: rows.map((r) => toFollow(req, r, false)), next_cursor: null };
  });

  app.get<{ Params: { id: string } }>("/v1/follows/:id", async (req) => {
    const row = await deps.data.withAccount(req.accountId!, (s) => s.db.selectFrom("follows").selectAll().where("id", "=", req.params.id).executeTakeFirst());
    if (!row || !visible(req, row)) throw new ApiError(404, "not_found", "follow not found");
    return toFollow(req, row, true);
  });

  app.delete<{ Params: { id: string } }>("/v1/follows/:id", async (req, reply) => {
    const gone = await deps.data.withAccount(req.accountId!, (s) => s.db.deleteFrom("follows").where("id", "=", req.params.id).executeTakeFirst());
    if (!gone.numDeletedRows) throw new ApiError(404, "not_found", "follow not found");
    return reply.code(204).send();
  });
}
