// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { egressPolicyFromEnv, webhookUrlProblem } from "../egress.js";
import { grantFilter } from "../access.js";
import type { Database } from "../data/schema.js";
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DataAccess } from "../data/access.js";
import { newId } from "../data/ids.js";
import { ApiError } from "../errors.js";
import { type EventUrls, toEvent, typeFilter } from "../events.js";
import { isProduction } from "../ingest.js";

const toWebhook = (w: { id: string; url: string; events: string[]; created_at: Date | string }, secret?: string) => ({
  id: w.id, url: w.url, events: w.events, ...(secret ? { secret } : {}), created_at: new Date(w.created_at).toISOString(),
});
const toDelivery = (d: {
  id: string; webhook_id: string; event_id: string; status: string; attempts: number; last_status_code: number | null;
  last_error: string | null; next_attempt_at: Date | null; delivered_at: Date | null; created_at: Date | string;
}) => ({
  id: d.id, webhook_id: d.webhook_id, event_id: d.event_id, status: d.status, attempts: d.attempts,
  last_status_code: d.last_status_code, last_error: d.last_error,
  next_attempt_at: d.next_attempt_at ? new Date(d.next_attempt_at).toISOString() : null,
  delivered_at: d.delivered_at ? new Date(d.delivered_at).toISOString() : null,
  created_at: new Date(d.created_at).toISOString(),
});

/** Refuses webhook targets that are not public. The delivery worker re-checks the resolved address on every attempt. */
export function checkWebhookUrl(raw: string, production = isProduction(), policy = egressPolicyFromEnv()) {
  const problem = webhookUrlProblem(raw, { production, policy });
  if (problem) throw new ApiError(400, "validation_failed", problem);
}

export function registerEventRoutes(app: FastifyInstance, deps: { data: DataAccess; urls: (req: { protocol: string; host: string }) => EventUrls }) {
  app.get<{ Querystring: { source?: string; type?: string; from?: string; to?: string; limit?: string; cursor?: string } }>("/v1/events", async (req) => {
    const q = req.query;
    const limit = Math.min(Math.max(Number(q.limit ?? 20), 1), 100);
    const rows = await deps.data.withAccount(req.accountId!, async (s) => {
      let query = s.db.selectFrom("events").selectAll().orderBy("occurred_at", "desc").orderBy("id", "desc").limit(limit + 1);
      const granted = grantFilter<Database, "events">(req, "occurred_at");
      if (granted) query = query.where(granted);
      if (q.source) query = query.where("source_id", "=", q.source);
      if (q.type) {
        const f = typeFilter(q.type);
        query = query.where("type", f.op, f.value);
      }
      if (q.from) query = query.where("occurred_at", ">=", new Date(q.from));
      if (q.to) query = query.where("occurred_at", "<", new Date(q.to));
      if (q.cursor) query = query.where("id", "<", q.cursor);
      const events = await query.execute();
      const sources = new Map((await s.sources.list()).map((x) => [x.id, x]));
      return events.map((e) => ({ e, src: sources.get(e.source_id) }));
    });
    const urls = deps.urls(req);
    const page = rows.slice(0, limit);
    return { data: page.map(({ e, src }) => toEvent(e, src, urls)), next_cursor: rows.length > limit ? page.at(-1)!.e.id : null };
  });

  app.get<{ Params: { id: string } }>("/v1/events/:id", async (req) => {
    const found = await deps.data.withAccount(req.accountId!, async (s) => {
      let q = s.db.selectFrom("events").selectAll().where("id", "=", req.params.id);
      const granted = grantFilter<Database, "events">(req, "occurred_at");
      if (granted) q = q.where(granted);
      const e = await q.executeTakeFirst();
      return e ? { e, src: await s.sources.get(e.source_id) } : undefined;
    });
    if (!found) throw new ApiError(404, "not_found", "event not found");
    return toEvent(found.e, found.src, deps.urls(req));
  });

  app.post<{ Params: { id: string }; Body: { feedback: "relevant" | "not_relevant" } }>(
    "/v1/events/:id/feedback",
    { schema: { body: { type: "object", required: ["feedback"], additionalProperties: false, properties: { feedback: { enum: ["relevant", "not_relevant"] } } } } },
    async (req, reply) => {
      // Agents may only give feedback on events their grants let them see.
      const granted = grantFilter<Database, "events">(req, "occurred_at");
      const r = await deps.data.withAccount(req.accountId!, (s) => {
        let q = s.db.updateTable("events").set({ feedback: req.body.feedback }).where("id", "=", req.params.id);
        if (granted) q = q.where(granted as never);
        return q.executeTakeFirst();
      });
      if (!r.numUpdatedRows) throw new ApiError(404, "not_found", "event not found");
      return reply.code(204).send();
    },
  );

  // --- Webhooks ------------------------------------------------------------------
  app.post<{ Body: { url: string; events: string[] } }>(
    "/v1/webhooks",
    { schema: { body: { type: "object", required: ["url", "events"], additionalProperties: false, properties: { url: { type: "string" }, events: { type: "array", minItems: 1, items: { type: "string" } } } } } },
    async (req, reply) => {
      checkWebhookUrl(req.body.url);
      const secret = `whsec_${randomBytes(24).toString("base64url")}`;
      const row = await deps.data.withAccount(req.accountId!, (s) =>
        s.db.insertInto("webhooks").values({ id: newId("whk"), account_id: req.accountId!, url: req.body.url, events: req.body.events, secret: deps.data.box().encrypt(secret) }).returningAll().executeTakeFirstOrThrow(),
      );
      return reply.code(201).send(toWebhook(row, secret));
    },
  );
  app.get("/v1/webhooks", async (req) => {
    const rows = await deps.data.withAccount(req.accountId!, (s) => s.db.selectFrom("webhooks").selectAll().orderBy("created_at").execute());
    return { data: rows.map((w) => toWebhook(w)), next_cursor: null };
  });
  app.delete<{ Params: { id: string } }>("/v1/webhooks/:id", async (req, reply) => {
    const r = await deps.data.withAccount(req.accountId!, (s) => s.db.deleteFrom("webhooks").where("id", "=", req.params.id).executeTakeFirst());
    if (!r.numDeletedRows) throw new ApiError(404, "not_found", "webhook not found");
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>("/v1/webhooks/:id/deliveries", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100);
    const rows = await deps.data.withAccount(req.accountId!, async (s) => {
      let q = s.db.selectFrom("webhook_deliveries").selectAll().where("webhook_id", "=", req.params.id).orderBy("id", "desc").limit(limit + 1);
      if (req.query.cursor) q = q.where("id", "<", req.query.cursor);
      return q.execute();
    });
    const page = rows.slice(0, limit);
    return { data: page.map(toDelivery), next_cursor: rows.length > limit ? page.at(-1)!.id : null };
  });
  app.post<{ Params: { id: string; deliveryId: string } }>("/v1/webhooks/:id/deliveries/:deliveryId/redeliver", async (req, reply) => {
    const row = await deps.data.withAccount(req.accountId!, async (s) => {
      const d = await s.db.selectFrom("webhook_deliveries").selectAll().where("id", "=", req.params.deliveryId).where("webhook_id", "=", req.params.id).executeTakeFirst();
      if (!d) return undefined;
      // A fresh delivery row keeps the log honest (the original attempt stays as it was).
      return s.db.insertInto("webhook_deliveries")
        .values({ id: newId("dlv"), account_id: req.accountId!, webhook_id: d.webhook_id, event_id: d.event_id })
        .returningAll().executeTakeFirstOrThrow();
    });
    if (!row) throw new ApiError(404, "not_found", "delivery not found");
    return reply.code(202).send(toDelivery(row));
  });
}
