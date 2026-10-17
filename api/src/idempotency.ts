// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Idempotency-Key on create routes (ADR 0030): the first response for an
// account and key is stored for 24 h; a retry with the same body gets it back
// (Idempotent-Replayed: true), a different body is refused.
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sql } from "kysely";
import type { DataAccess } from "./data/access.js";
import { ApiError } from "./errors.js";

export const IDEMPOTENT_ROUTES = new Set(["POST /v1/sources", "POST /v1/watches", "POST /v1/clips", "POST /v1/webhooks", "POST /v1/grants"]);

declare module "fastify" {
  interface FastifyRequest {
    idempotency?: { key: string; route: string; hash: string };
  }
}

const hashOf = (body: unknown) => createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");

export function registerIdempotency(app: FastifyInstance, data: DataAccess) {
  // Runs after authentication (preHandler order), so req.accountId is set.
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    const route = `${req.method} ${req.routeOptions.url}`;
    const raw = req.headers["idempotency-key"];
    if (!IDEMPOTENT_ROUTES.has(route) || typeof raw !== "string" || !req.accountId) return;
    const key = raw.trim();
    if (!key || key.length > 255) throw new ApiError(400, "validation_failed", "Idempotency-Key must be 1–255 characters");
    const hash = hashOf(req.body);
    const prior = await data.withAccount(req.accountId, (s) =>
      s.db.selectFrom("idempotency_keys").selectAll().where("key", "=", key)
        .where("created_at", ">", new Date(Date.now() - 24 * 3600_000)).executeTakeFirst());
    if (prior) {
      if (prior.route !== route || prior.request_hash !== hash) {
        throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was used for a different request");
      }
      return reply.code(prior.status_code).header("idempotent-replayed", "true").type("application/json").send(prior.response);
    }
    req.idempotency = { key, route, hash };
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const i = req.idempotency;
    if (!i || !req.accountId || reply.statusCode >= 500 || reply.getHeader("idempotent-replayed")) return payload;
    if (typeof payload !== "string") return payload;
    await data.withAccount(req.accountId, (s) =>
      s.db.insertInto("idempotency_keys").values({ account_id: req.accountId!, key: i.key, route: i.route, request_hash: i.hash, status_code: reply.statusCode, response: payload })
        .onConflict((oc) => oc.columns(["account_id", "key"]).doNothing()).execute(),
    ).catch((err) => req.log.warn({ err }, "idempotency record failed"));
    return payload;
  });
}

export async function expireIdempotencyKeys(data: DataAccess): Promise<number> {
  const { rows } = await sql<{ expire_idempotency_keys: number }>`select expire_idempotency_keys()`.execute(data.db());
  return Number(rows[0]?.expire_idempotency_keys ?? 0);
}
