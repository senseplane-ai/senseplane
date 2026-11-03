// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Who made a request, and through what: a signed-in person, a workspace key
// or an agent (and a Telegram chat's agent). Switching devices (ADR 0067) and
// speaking through cameras (ADR 0069) record it with every attempt.
import type { FastifyRequest } from "fastify";
import type { AccountScope } from "./data/access.js";
import { ApiError } from "./errors.js";

/** Who asked, and through what. There is no internal caller: every request comes from one of these. */
export interface Principal {
  kind: "user" | "account_key" | "agent";
  actor: string;
  id: string;
  name: string | null;
  via: "console" | "app" | "telegram" | "agent" | "api";
  userId?: string;
  agentId?: string;
  /** A Telegram chat's agent: the chat, and the person it belongs to when it qualifies (see personChat). */
  channelId?: string;
  person?: { userId: string; name: string };
}

/** The request's principal, read from the API key it came with. */
export async function principalOf(req: FastifyRequest, s: AccountScope): Promise<Principal> {
  const a = req.access;
  if (!a || a.integrationSource) throw new ApiError(403, "forbidden", "this token can't switch devices");
  if (a.agentId) {
    const agent = await s.db.selectFrom("agents").select(["name", "kind", "client_name"]).where("id", "=", a.agentId).executeTakeFirst();
    const p: Principal = { kind: "agent", actor: a.actor, id: a.agentId, agentId: a.agentId, name: agent?.client_name ?? agent?.name ?? null, via: agent?.kind === "channel" ? "telegram" : "agent" };
    if (agent?.kind === "channel") {
      const ch = await s.db.selectFrom("channels").select("id").where("agent_id", "=", a.agentId).where("status", "=", "active").executeTakeFirst();
      if (ch) p.channelId = ch.id;
    }
    return p;
  }
  if (a.userId) {
    const user = await s.db.selectFrom("users").select(["name", "email"]).where("id", "=", a.userId).executeTakeFirst();
    const via = String(req.headers["x-senseplane-via"] ?? "").toLowerCase() === "app" ? "app" : "console";
    return { kind: "user", actor: a.actor, id: a.userId, userId: a.userId, name: user?.name ?? user?.email ?? null, via };
  }
  const prefix = a.actor.replace(/^owner:/, "");
  const key = await s.db.selectFrom("api_keys").select("name").where("prefix", "like", `${prefix}%`).where("agent_id", "is", null).where("user_id", "is", null).executeTakeFirst();
  return { kind: "account_key", actor: a.actor, id: prefix, name: key?.name ?? null, via: "api" };
}
