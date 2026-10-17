// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Agent inboxes (ADR 0043): events routed to an agent by a watch's `notify`.
// An agent key reads its own inbox; an account key names the agent. Items are
// filtered by the agent's current grants, like every other read (ADR 0024).
import type { FastifyInstance, FastifyRequest } from "fastify";
import { grantFilter } from "../access.js";
import type { DataAccess } from "../data/access.js";
import type { Database } from "../data/schema.js";
import { ApiError } from "../errors.js";
import { type EventUrls, toEvent } from "../events.js";

function agentFor(req: FastifyRequest, asked: string | undefined): string {
  const own = req.access?.agentId;
  if (own) {
    if (asked && asked !== own) throw new ApiError(403, "forbidden", "an agent key can only read its own inbox");
    return own;
  }
  if (!asked) throw new ApiError(400, "validation_failed", "agent is required with an account key");
  return asked;
}

export function registerInboxRoutes(app: FastifyInstance, deps: { data: DataAccess; urls: (req: { protocol: string; host: string }) => EventUrls }) {
  app.get<{ Querystring: { agent?: string; unseen?: string; limit?: string; cursor?: string } }>("/v1/inbox", async (req) => {
    const agentId = agentFor(req, req.query.agent);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
    const granted = grantFilter<Database, "events">(req, "occurred_at");
    const rows = await deps.data.withAccount(req.accountId!, async (s) => {
      const agent = await s.db.selectFrom("agents").select("id").where("id", "=", agentId).executeTakeFirst();
      if (!agent) throw new ApiError(404, "not_found", "agent not found");
      let q = s.db.selectFrom("agent_inbox").selectAll().where("agent_id", "=", agentId).orderBy("id", "desc").limit(limit + 1);
      if (req.query.unseen === "true") q = q.where("seen_at", "is", null);
      if (req.query.cursor) q = q.where("id", "<", req.query.cursor);
      const items = await q.execute();
      if (!items.length) return [];
      let eq = s.db.selectFrom("events").selectAll().where("id", "in", items.map((i) => i.event_id));
      if (granted) eq = eq.where(granted);
      const events = new Map((await eq.execute()).map((e) => [e.id, e]));
      const sources = new Map((await s.sources.list()).map((x) => [x.id, x]));
      return items.map((i) => ({ i, e: events.get(i.event_id), src: sources.get(events.get(i.event_id)?.source_id ?? "") }));
    });
    const urls = deps.urls(req);
    const page = rows.slice(0, limit);
    return {
      agent_id: agentId,
      data: page.filter((r) => r.e).map(({ i, e, src }) => ({
        id: i.id, ...(i.watch_id ? { watch_id: i.watch_id } : {}), created_at: new Date(i.created_at).toISOString(),
        seen_at: i.seen_at ? new Date(i.seen_at).toISOString() : null, event: toEvent(e!, src, urls),
      })),
      next_cursor: rows.length > limit ? page.at(-1)!.i.id : null,
    };
  });

  app.post<{ Body: { agent_id?: string; ids?: string[]; all?: boolean } }>(
    "/v1/inbox/seen",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
      agent_id: { type: "string" }, ids: { type: "array", maxItems: 500, items: { type: "string" } }, all: { type: "boolean" },
    } } } },
    async (req) => {
      const agentId = agentFor(req, req.body.agent_id);
      if (!req.body.all && !req.body.ids?.length) throw new ApiError(400, "validation_failed", "give ids or all: true");
      const r = await deps.data.withAccount(req.accountId!, (s) => {
        let q = s.db.updateTable("agent_inbox").set({ seen_at: new Date() }).where("agent_id", "=", agentId).where("seen_at", "is", null);
        if (!req.body.all) q = q.where("id", "in", req.body.ids!);
        return q.executeTakeFirst();
      });
      return { marked: Number(r.numUpdatedRows) };
    },
  );
}
