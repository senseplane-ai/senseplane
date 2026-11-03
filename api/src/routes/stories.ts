// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Multi-camera stories (ADR 0070): POST makes one from moments or a search
// and queues its render; GET shows its pieces and, once ready, a signed HLS
// link (the same /playback/{token}/ routes as recordings and clips).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DataAccess } from "../data/access.js";
import { ApiError } from "../errors.js";
import type { ApiBus } from "../indexer.js";
import { storyClaims } from "../media-access.js";
import type { AuditLog } from "../module.js";
import type { KeyRefSealer, PlaybackSigner } from "../playback.js";
import { type PieceRow, STORY_LIMITS, type StoryInput, type StoryRow, createStory, planStory, toStory } from "../stories.js";
import type { ObjectStorage } from "../storage.js";

export interface StoryRouteDeps {
  data: DataAccess;
  storage: ObjectStorage;
  signer: PlaybackSigner;
  apiPublicUrl?: string;
  ttlSeconds: number;
  keyRefs?: KeyRefSealer;
  bus?: ApiBus;
  audit?: AuditLog;
}

/** A shared link lives at most a week; revoking the key, a grant, or deleting the story ends it sooner. */
const MAX_LINK_S = 7 * 86_400;

const MOMENT = {
  type: "object", additionalProperties: false,
  properties: { event: { type: "string" }, source: { type: "string" }, from: { type: "string" }, to: { type: "string" } },
};
export const STORY_BODY = {
  type: "object", additionalProperties: false,
  properties: {
    title: { type: "string", maxLength: 200 },
    moments: { type: "array", minItems: 1, maxItems: 50, items: MOMENT },
    search: {
      type: "object", additionalProperties: false, required: ["q"],
      properties: { q: { type: "string", minLength: 2, maxLength: 500 }, from: { type: "string" }, to: { type: "string" },
        sources: { type: "array", items: { type: "string" }, maxItems: 50 }, limit: { type: "integer", minimum: 1, maximum: STORY_LIMITS.pieces } },
    },
    mode: { type: "string", enum: ["labelled", "fast"] },
  },
};

/** Makes a story for this caller: checks its grants on every piece, records it and queues the render. Shared with chat and following. */
export async function makeStory(deps: Pick<StoryRouteDeps, "data" | "bus" | "audit">, req: FastifyRequest, input: StoryInput) {
  const pieces = await planStory(deps, req, input);
  const out = await createStory(deps.data, req.accountId!, pieces, {
    title: input.title?.trim() || null, mode: input.mode ?? "labelled", actor: req.access?.actor ?? "account", agentId: req.access?.agentId ?? null,
  });
  await deps.audit?.write({
    accountId: req.accountId!, actor: req.access?.actor ?? "account", action: "story.created", target: out.story.id, status: 202,
    details: { mode: out.story.mode, pieces: pieces.length, sources: [...new Set(pieces.map((p) => p.source_id))] },
  }).catch(() => undefined);
  return out;
}

export function registerStoryRoutes(app: FastifyInstance, deps: StoryRouteDeps) {
  const base = (req: { protocol: string; host: string }) => deps.apiPublicUrl ?? `${req.protocol}://${req.host}`;
  const load = (accountId: string, id: string) => deps.data.withAccount(accountId, async (s) => {
    const story = await s.db.selectFrom("stories").selectAll().where("id", "=", id).executeTakeFirst();
    if (!story) return undefined;
    return { story, pieces: await s.db.selectFrom("story_pieces").selectAll().where("story_id", "=", id).orderBy("seq").execute() };
  });
  /** Agents see a story only when they could have made it: video on every camera in it, none of them blurred only. */
  const visible = (req: FastifyRequest, pieces: PieceRow[]) => !req.access?.grants || storyClaims(req, deps.keyRefs ?? NO_SEAL, pieces) !== null;
  const link = (req: FastifyRequest, story: StoryRow, pieces: PieceRow[], ttl: number) => {
    const claims = deps.keyRefs ? storyClaims(req, deps.keyRefs, pieces) : {};
    if (!claims) throw new ApiError(403, "forbidden_sense", "this agent has no video grant for every camera in this story");
    const { token, expiresAt } = deps.signer.sign({ kind: "story", accountId: req.accountId!, storyId: story.id, ...claims }, ttl);
    return { url: `${base(req)}/playback/${token}/index.m3u8`, expiresAt };
  };
  const get = async (req: FastifyRequest, id: string) => {
    const found = await load(req.accountId!, id);
    if (!found || !visible(req, found.pieces)) throw new ApiError(404, "not_found", "story not found");
    return found;
  };

  app.post<{ Body: StoryInput }>("/v1/stories", { schema: { body: STORY_BODY } }, async (req, reply) => {
    if (!req.body.moments?.length && !req.body.search) throw new ApiError(400, "validation_failed", "give moments or a search");
    const { story, pieces } = await makeStory(deps, req, req.body);
    return reply.code(202).send(toStory(story, pieces));
  });

  app.get<{ Querystring: { limit?: string } }>("/v1/stories", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const rows = await deps.data.withAccount(req.accountId!, async (s) => {
      const stories = await s.db.selectFrom("stories").selectAll().orderBy("created_at", "desc").limit(limit).execute();
      const pieces = stories.length ? await s.db.selectFrom("story_pieces").selectAll().where("story_id", "in", stories.map((x) => x.id)).execute() : [];
      return stories.map((story) => ({ story, pieces: pieces.filter((p) => p.story_id === story.id) }));
    });
    return { data: rows.filter((r) => visible(req, r.pieces)).map((r) => toStory(r.story, r.pieces)), next_cursor: null };
  });

  app.get<{ Params: { id: string } }>("/v1/stories/:id", async (req) => {
    const { story, pieces } = await get(req, req.params.id);
    return toStory(story, pieces, story.status === "ready" ? link(req, story, pieces, deps.ttlSeconds) : undefined);
  });

  // A longer-lived link to share with a person: still checked on every request against the key that made it (ADR 0036).
  app.post<{ Params: { id: string }; Body: { expires_in_s?: number } }>(
    "/v1/stories/:id/link",
    { schema: { body: { type: "object", additionalProperties: false, properties: { expires_in_s: { type: "integer", minimum: 60, maximum: MAX_LINK_S } } } } },
    async (req) => {
      const { story, pieces } = await get(req, req.params.id);
      if (story.status !== "ready") throw new ApiError(409, "conflict", `this story is ${story.status}, not ready yet`);
      const ttl = req.body?.expires_in_s ?? 86_400;
      const out = link(req, story, pieces, ttl);
      await deps.audit?.write({ accountId: req.accountId!, actor: req.access?.actor ?? "account", action: "story.link_created", target: story.id, status: 200,
        details: { expires_at: out.expiresAt.toISOString() } }).catch(() => undefined);
      return { url: out.url, expires_at: out.expiresAt.toISOString() };
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/stories/:id", async (req, reply) => {
    await get(req, req.params.id);
    const keys = await deps.data.withAccount(req.accountId!, async (s) => {
      const segs = await s.db.selectFrom("story_segments").select(["key", "init_key"]).where("story_id", "=", req.params.id).execute();
      await s.db.deleteFrom("stories").where("id", "=", req.params.id).execute();
      return [...new Set(segs.flatMap((x) => [x.key, x.init_key]))];
    });
    await deps.storage.deleteMany(keys);
    await deps.storage.deletePrefix(`stories/${req.accountId!}/${req.params.id}/`);
    return reply.code(204).send();
  });
}

/** Visibility only needs the grants, not a sealed key. */
const NO_SEAL: KeyRefSealer = { seal: () => "", open: () => undefined };
