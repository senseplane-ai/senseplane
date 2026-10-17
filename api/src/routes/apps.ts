// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Connected apps (ADR 0048): the MCP consent page in the console approves an
// MCP client for this workspace. `POST /v1/agents/connect` (admins, with a
// console session) creates or reuses the app's agent, sets its access and
// returns a single-use connect code. The console hands that code to the MCP
// service in a form post; the MCP service redeems it here, server to server,
// for the app's agent key (`POST /auth/connect/redeem`), proving with the nonce
// sealed in its own authorization request that it is the request the person
// approved. The key never reaches the browser.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type DataAccess, hashApiKey } from "../data/access.js";
import { newId } from "../data/ids.js";
import { ApiError } from "../errors.js";
import type { AuditLog } from "../module.js";
import { limiter } from "../rate-limit.js";
import { type AccessBody, accessProperties, insertGrant, listAgents, toAgent } from "./trust.js";

/** Connect codes live this long: the consent page posts them to the MCP service at once. */
export const CONNECT_CODE_TTL_S = 120;
/** Keys kept per connected app, one per machine that connected it; reconnecting beyond this revokes the oldest. */
export const APP_KEYS_KEPT = 5;

/**
 * The part of a redirect host that identifies an app across reconnects: no
 * port (loopback clients pick a new one each time) and every loopback name as
 * `localhost`.
 */
export function appHost(host: string): string {
  const h = host.trim().toLowerCase();
  const bare = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.replace(/:\d+$/, "");
  return ["localhost", "127.0.0.1", "[::1]"].includes(bare) ? "localhost" : bare;
}

const sha = (s: string) => createHash("sha256").update(s).digest("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function registerAppRoutes(app: FastifyInstance, deps: { data: DataAccess; audit: AuditLog; redeemsPerMinute?: number }) {
  const { data } = deps;

  type ConnectBody = AccessBody & { client_name: string; redirect_host: string; binding: string };
  app.post<{ Body: ConnectBody }>("/v1/agents/connect", {
    schema: { body: { type: "object", required: ["client_name", "redirect_host", "binding", "source_ids", "senses"], additionalProperties: false, properties: {
      client_name: { type: "string", minLength: 1, maxLength: 100 }, redirect_host: { type: "string", minLength: 1, maxLength: 255 },
      binding: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }, ...accessProperties,
    } } },
  }, async (req, reply) => {
    const b = req.body;
    const host = appHost(b.redirect_host);
    const accountId = req.accountId!;
    const out = await data.withAccount(accountId, async (s) => {
      // Same client name and redirect host as a live app: reuse it, replacing its access.
      const existing = await s.db.selectFrom("agents").select("id").where("kind", "=", "app").where("client_name", "=", b.client_name)
        .where("client_host", "=", host).where("revoked_at", "is", null).orderBy("created_at", "desc").executeTakeFirst();
      let agentId: string;
      if (existing) {
        agentId = existing.id;
        await s.db.deleteFrom("grants").where("agent_id", "=", agentId).execute();
        await s.db.updateTable("agents").set({ connected_at: new Date() }).where("id", "=", agentId).execute();
      } else {
        agentId = newId("agt");
        await s.db.insertInto("agents").values({
          id: agentId, account_id: accountId, name: b.client_name, kind: "app", client_name: b.client_name, client_host: host, connected_at: new Date(),
        }).execute();
      }
      await insertGrant(s.db, () => s.sources.list(), accountId, agentId, b);
      const code = `cc_${randomBytes(32).toString("base64url")}`;
      const expires = new Date(Date.now() + CONNECT_CODE_TTL_S * 1000);
      await s.db.insertInto("agent_connect_codes").values({
        id: `ccd_${randomBytes(10).toString("hex")}`, account_id: accountId, agent_id: agentId, code_hash: hashApiKey(code), binding: b.binding,
        client_name: b.client_name, client_host: host, approved_by: req.access?.userId ?? null, expires_at: expires,
      }).execute();
      const [row] = await listAgents(s.db, accountId, agentId);
      return { agent: toAgent(row!), code, expires, reused: !!existing };
    });
    await deps.audit.write({
      accountId, actor: req.access?.actor ?? "owner", action: "app.connected", target: out.agent.id,
      details: { client_name: b.client_name, redirect_host: b.redirect_host, reused: out.reused, sources: b.source_ids.length, senses: b.senses, abilities: b.abilities ?? ["watch", "history"] },
    }).catch(() => undefined);
    return reply.code(201).send({ agent: out.agent, code: out.code, expires_at: out.expires.toISOString(), reused: out.reused });
  });

  // Called by the MCP service. The code is 256 random bits and single-use; the per-IP limit is
  // generous because every redeem on an instance comes from the MCP service's address.
  const allow = limiter(deps.redeemsPerMinute ?? 120, 60_000);
  const refuse = (reason: string, message: string) => new ApiError(400, "validation_failed", message, { reason });
  app.post<{ Body: { code: string; nonce: string; client_name: string; redirect_host: string } }>("/auth/connect/redeem", {
    schema: { body: { type: "object", required: ["code", "nonce", "client_name", "redirect_host"], additionalProperties: false, properties: {
      code: { type: "string", maxLength: 200 }, nonce: { type: "string", maxLength: 200 }, client_name: { type: "string", maxLength: 100 }, redirect_host: { type: "string", maxLength: 255 },
    } } },
  }, async (req: FastifyRequest<{ Body: { code: string; nonce: string; client_name: string; redirect_host: string } }>, reply) => {
    if (!allow(req.ip)) throw new ApiError(429, "rate_limited", "too many connect attempts");
    reply.header("cache-control", "no-store");
    const b = req.body;
    const found = b.code.startsWith("cc_") ? await data.connectCodeByHash(hashApiKey(b.code)) : undefined;
    if (!found) throw refuse("code_invalid", "this connect code isn't valid");
    // Spent on first use (its own transaction), even when the checks below fail.
    const row = await data.withAccount(found.accountId, (s) => s.db.updateTable("agent_connect_codes").set({ used_at: new Date() }).where("id", "=", found.id)
      .where("used_at", "is", null).where("expires_at", ">", new Date()).returningAll().executeTakeFirst());
    if (!row) throw refuse("code_invalid", "this connect code was already used or has expired");
    if (!same(sha(b.nonce), row.binding) || row.client_name !== b.client_name || row.client_host !== appHost(b.redirect_host)) {
      throw refuse("mismatch", "this connect code was approved for another request");
    }
    return data.withAccount(found.accountId, async (s) => {
      const agent = await s.db.selectFrom("agents").select(["id", "name"]).where("id", "=", row.agent_id).where("revoked_at", "is", null).executeTakeFirst();
      if (!agent) throw new ApiError(404, "not_found", "this app was disconnected");
      const key = await s.apiKeys.create(`app ${agent.name}`, agent.id);
      // One key per connection (machine); keep the newest few.
      const keep = s.db.selectFrom("api_keys").select("id").where("agent_id", "=", agent.id).where("revoked_at", "is", null).orderBy("created_at", "desc").limit(APP_KEYS_KEPT);
      await s.db.updateTable("api_keys").set({ revoked_at: new Date() }).where("agent_id", "=", agent.id).where("revoked_at", "is", null).where("id", "not in", keep).execute();
      return { api_key: key.key, agent_id: agent.id };
    });
  });
}
