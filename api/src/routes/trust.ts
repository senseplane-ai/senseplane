// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Agents, grants, the audit log, account export and deletion (ADR 0024).
// Owner-only: agent keys are refused by checkRoute before they get here.
// Connected apps (MCP consent, ADR 0048) are agents too: see apps.ts.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import { ABILITIES } from "../access.js";
import type { DataAccess } from "../data/access.js";
import { newId } from "../data/ids.js";
import type { AgentKind, Database } from "../data/schema.js";
import { ApiError } from "../errors.js";
import { type EventUrls, toEvent } from "../events.js";
import type { ObjectStorage } from "../storage.js";
import { toSource } from "./sources.js";
import { toWatch } from "./watches.js";

export const SENSES = ["video", "audio", "temperature", "humidity"];
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : undefined);

/** Request body schema for a grant's access (shared by POST /v1/grants and the consent page's connect). */
export const accessProperties = {
  source_ids: { type: "array", minItems: 1, maxItems: 200, items: { type: "string" } },
  senses: { type: "array", minItems: 1, items: { enum: SENSES } },
  abilities: { type: "array", items: { enum: [...ABILITIES] } },
  window: { type: "object", additionalProperties: false, properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } } },
} as const;
export interface AccessBody { source_ids: string[]; senses: string[]; abilities?: string[]; window?: { from?: string; to?: string } }

type GrantRow = { id: string; agent_id: string; source_ids: string[]; senses: string[]; window_from: Date | null; window_to: Date | null; abilities: string[]; created_at: Date };
export const toGrant = (g: GrantRow) => ({
  id: g.id, agent_id: g.agent_id, source_ids: g.source_ids, senses: g.senses, abilities: g.abilities,
  ...(g.window_from || g.window_to ? { window: { ...(g.window_from ? { from: iso(g.window_from) } : {}), ...(g.window_to ? { to: iso(g.window_to) } : {}) } } : {}),
  created_at: iso(g.created_at),
});

/** Inserts a grant after checking its sources exist in the account (inside withAccount). */
export async function insertGrant(db: Kysely<Database>, sources: () => Promise<{ id: string }[]>, accountId: string, agentId: string, b: AccessBody) {
  if (b.window?.from && b.window?.to && new Date(b.window.from) >= new Date(b.window.to)) throw new ApiError(400, "validation_failed", "window.from must be before window.to");
  const known = new Set((await sources()).map((x) => x.id));
  const missing = b.source_ids.filter((id) => !known.has(id));
  if (missing.length) throw new ApiError(404, "not_found", `unknown sources: ${missing.join(", ")}`);
  return db.insertInto("grants").values({
    id: newId("grt"), account_id: accountId, agent_id: agentId, source_ids: [...new Set(b.source_ids)], senses: [...new Set(b.senses)],
    abilities: [...new Set(b.abilities ?? ABILITIES)], window_from: b.window?.from ?? null, window_to: b.window?.to ?? null,
  }).returningAll().executeTakeFirstOrThrow();
}

type AgentRow = {
  id: string; name: string; kind: AgentKind; client_name: string | null; client_host: string | null; connected_at: Date | null; created_at: Date;
  prefix?: string | null; last_active_at?: Date | string | null;
};
export const toAgent = (r: AgentRow) => ({
  id: r.id, name: r.name, kind: r.kind, ...(r.prefix ? { key_prefix: r.prefix } : {}),
  ...(r.kind === "app" ? { client_name: r.client_name ?? r.name, redirect_host: r.client_host ?? "", connected_at: iso(r.connected_at ?? r.created_at) } : {}),
  last_active_at: iso(r.last_active_at) ?? null, created_at: iso(r.created_at),
});

/** Live agents with their newest live key prefix and when they last made a request (from the audit log). */
export function listAgents(db: Kysely<Database>, accountId: string, id?: string) {
  let q = db.selectFrom("agents").select(["agents.id", "agents.name", "agents.kind", "agents.client_name", "agents.client_host", "agents.connected_at", "agents.created_at"])
    .select((eb) => [
      eb.selectFrom("api_keys").select("api_keys.prefix").whereRef("api_keys.agent_id", "=", "agents.id").where("api_keys.revoked_at", "is", null)
        .orderBy("api_keys.created_at", "desc").limit(1).as("prefix"),
      eb.selectFrom("audit_log").select((e) => e.fn.max("audit_log.occurred_at").as("m")).where("audit_log.account_id", "=", accountId)
        .where(sql<boolean>`audit_log.actor = 'agent:' || agents.id`).as("last_active_at"),
    ])
    .where("agents.revoked_at", "is", null).orderBy("agents.created_at");
  if (id) q = q.where("agents.id", "=", id);
  return q.execute();
}

export function registerTrustRoutes(app: FastifyInstance, deps: {
  data: DataAccess; storage?: ObjectStorage; urls: (req: { protocol: string; host: string }) => EventUrls;
}) {
  // --- agents ------------------------------------------------------------------
  app.post<{ Body: { name: string } }>(
    "/v1/agents",
    { schema: { body: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 120 } } } } },
    async (req, reply) => {
      const out = await deps.data.withAccount(req.accountId!, async (s) => {
        const agent = await s.db.insertInto("agents").values({ id: newId("agt"), account_id: req.accountId!, name: req.body.name }).returningAll().executeTakeFirstOrThrow();
        const key = await s.apiKeys.create(`agent ${agent.name}`, agent.id);
        return { agent, key };
      });
      return reply.code(201).send({ ...toAgent({ ...out.agent, prefix: out.key.prefix }), api_key: out.key.key });
    },
  );
  app.get("/v1/agents", async (req) => {
    const rows = await deps.data.withAccount(req.accountId!, (s) => listAgents(s.db, req.accountId!));
    return { data: rows.map(toAgent), next_cursor: null };
  });
  app.delete<{ Params: { id: string } }>("/v1/agents/:id", async (req, reply) => {
    const n = await deps.data.withAccount(req.accountId!, async (s) => {
      const r = await s.db.updateTable("agents").set({ revoked_at: new Date() }).where("id", "=", req.params.id).where("revoked_at", "is", null).executeTakeFirst();
      await s.db.updateTable("api_keys").set({ revoked_at: new Date() }).where("agent_id", "=", req.params.id).execute();
      await s.db.deleteFrom("grants").where("agent_id", "=", req.params.id).execute();
      // A linked chat's agent: removing it unlinks the chat (ADR 0059).
      await s.db.updateTable("channels").set({ status: "unlinked" }).where("agent_id", "=", req.params.id).execute();
      return Number(r.numUpdatedRows);
    });
    if (!n) throw new ApiError(404, "not_found", "agent not found");
    return reply.code(204).send();
  });

  // --- grants ------------------------------------------------------------------
  app.post<{ Body: AccessBody & { agent_id: string } }>(
    "/v1/grants",
    { schema: { body: { type: "object", required: ["agent_id", "source_ids", "senses"], additionalProperties: false, properties: { agent_id: { type: "string" }, ...accessProperties } } } },
    async (req, reply) => {
      const row = await deps.data.withAccount(req.accountId!, async (s) => {
        const agent = await s.db.selectFrom("agents").select("id").where("id", "=", req.body.agent_id).where("revoked_at", "is", null).executeTakeFirst();
        if (!agent) throw new ApiError(404, "not_found", "agent not found");
        return insertGrant(s.db, () => s.sources.list(), req.accountId!, req.body.agent_id, req.body);
      });
      return reply.code(201).send(toGrant(row));
    },
  );
  app.get("/v1/grants", async (req) => {
    const rows = await deps.data.withAccount(req.accountId!, (s) => s.db.selectFrom("grants").selectAll().orderBy("created_at").execute());
    return { data: rows.map(toGrant), next_cursor: null };
  });
  app.delete<{ Params: { id: string } }>("/v1/grants/:id", async (req, reply) => {
    const r = await deps.data.withAccount(req.accountId!, (s) => s.db.deleteFrom("grants").where("id", "=", req.params.id).executeTakeFirst());
    if (!r.numDeletedRows) throw new ApiError(404, "not_found", "grant not found");
    return reply.code(204).send();
  });

  // --- audit -------------------------------------------------------------------
  app.get<{ Querystring: { from?: string; to?: string; limit?: string; cursor?: string } }>("/v1/audit", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
    const rows = await deps.data.withAccount(req.accountId!, (s) => {
      let q = s.db.selectFrom("audit_log").selectAll().orderBy("id", "desc").limit(limit + 1);
      if (req.query.from) q = q.where("occurred_at", ">=", new Date(req.query.from));
      if (req.query.to) q = q.where("occurred_at", "<", new Date(req.query.to));
      if (req.query.cursor) q = q.where("id", "<", req.query.cursor);
      return q.execute();
    });
    const page = rows.slice(0, limit);
    return {
      data: page.map((r) => ({ id: String(r.id), actor: r.actor, action: r.action, target: r.target, ...(r.status ? { status: r.status } : {}), occurred_at: iso(r.occurred_at) })),
      next_cursor: rows.length > limit ? String(page.at(-1)!.id) : null,
    };
  });

  // --- export and deletion -----------------------------------------------------
  app.post("/v1/account/export", async (req, reply) => {
    if (!deps.storage) throw new ApiError(503, "service_unavailable", "exports need object storage");
    const accountId = req.accountId!;
    const urls = deps.urls(req);
    const doc = await deps.data.withAccount(accountId, async (s) => {
      const sources = await s.sources.list();
      const byId = new Map(sources.map((x) => [x.id, x]));
      const events = await s.db.selectFrom("events").selectAll().orderBy("occurred_at").execute();
      return {
        format: "senseplane-export/1", exported_at: new Date().toISOString(),
        account: await s.account.get(),
        sources: sources.map((x) => toSource(x)),
        watches: (await s.db.selectFrom("watches").selectAll().execute()).map(toWatch),
        events: events.map((e) => toEvent(e, byId.get(e.source_id), urls)),
        clips: await s.db.selectFrom("clips").selectAll().execute(),
        readings: await s.db.selectFrom("sensor_readings").selectAll().execute(),
        webhooks: (await s.db.selectFrom("webhooks").select(["id", "url", "events", "created_at"]).execute()),
        agents: await s.db.selectFrom("agents").selectAll().execute(),
        grants: await s.db.selectFrom("grants").selectAll().execute(),
        audit: await s.db.selectFrom("audit_log").selectAll().orderBy("id").execute(),
        usage: await s.db.selectFrom("usage_records").select(["kind", "detail", "source_id", "quantity", "at"]).orderBy("at").execute(),
        recordings: "Raw video is listed per source by GET /v1/sources/{id}/timeline and played with /playback; clips above carry their objects.",
      };
    });
    const id = `exp_${randomBytes(10).toString("hex")}`;
    await deps.storage.put(`exports/${accountId}/${id}.json`, Buffer.from(JSON.stringify(doc, null, 1)), "application/json");
    return reply.code(202).send(exportStatus(req, accountId, id));
  });
  const exportStatus = (req: { protocol: string; host: string }, accountId: string, id: string) => {
    const u = deps.urls(req);
    const ttl = 3600;
    const token = u.signer.sign({ kind: "object", accountId, key: `exports/${accountId}/${id}.json` }, ttl).token;
    return { export_id: id, status: "ready", url: `${u.base}/media/${token}/export.json`, expires_at: new Date(Date.now() + ttl * 1000).toISOString() };
  };
  app.get<{ Params: { id: string } }>("/v1/account/export/:id", async (req) => {
    if (!/^exp_[0-9a-f]{20}$/.test(req.params.id)) throw new ApiError(404, "not_found", "export not found");
    return exportStatus(req, req.accountId!, req.params.id);
  });
  app.delete("/v1/account", async (req, reply) => {
    const accountId = req.accountId!;
    await deps.data.withAccount(accountId, async (s) => {
      await s.db.updateTable("accounts").set({ deleted_at: new Date() }).where("id", "=", accountId).execute();
      await s.db.updateTable("api_keys").set({ revoked_at: new Date() }).where("revoked_at", "is", null).execute();
    });
    return reply.code(202).send();
  });
}
