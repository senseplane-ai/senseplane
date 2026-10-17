// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Teams and workspaces (ADR 0044): who is signed in (/v1/me), switching
// workspace, members and their roles, and invites. Role checks per route live
// in roles.ts; the rules that depend on who is being changed live here:
// only an owner touches owners, and a workspace always keeps one owner.
//
// API keys (not console sessions) act as an owner here.
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type AccountScope, type DataAccess, hashApiKey } from "../data/access.js";
import { newId } from "../data/ids.js";
import { ApiError } from "../errors.js";
import type { AuditLog } from "../module.js";
import { type Role, atLeast } from "../roles.js";
import { limiter } from "../rate-limit.js";

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const actorRole = (req: FastifyRequest): Role => req.access?.role ?? "owner";

export interface TeamConfig {
  /** Console URL invite links open (`<console>/#invite=<token>`). */
  consoleUrl: string;
  inviteDays: number;
  /** Invites an account may create per hour. */
  invitesPerHour: number;
}

/** Creates a console session for a user in an account and makes it their default workspace. */
export async function createSession(data: DataAccess, accountId: string, userId: string, days: number) {
  const expires = new Date(Date.now() + days * 86400_000);
  const k = await data.withAccount(accountId, (s) => s.apiKeys.create("console session", undefined, expires, userId));
  await data.db().updateTable("users").set({ account_id: accountId }).where("id", "=", userId).execute();
  return { session: k.key, expires_at: expires.toISOString(), account_id: accountId };
}

/** The workspace a sign-in opens: the preferred one if the user still belongs to it, else their oldest. */
export async function workspaceFor(data: DataAccess, userId: string, preferred: string | null): Promise<string> {
  const ms = await data.membershipsOf(userId);
  const pick = ms.find((m) => m.accountId === preferred) ?? ms[0];
  if (!pick) throw new ApiError(403, "forbidden", "You're not a member of any workspace. Ask an admin for an invite.");
  return pick.accountId;
}

export const inviteStatus = (i: { accepted_at: Date | null; revoked_at: Date | null; expires_at: Date }) =>
  i.revoked_at ? "revoked" : i.accepted_at ? "accepted" : new Date(i.expires_at).getTime() <= Date.now() ? "expired" : "pending";

/** Joins a user to the invite's account. Single use: a used, revoked or expired invite is refused. */
export async function acceptInvite(data: DataAccess, audit: AuditLog, invite: { id: string; accountId: string }, userId: string) {
  const role = await data.withAccount(invite.accountId, async (s) => {
    const row = await s.db.updateTable("invites").set({ accepted_at: new Date(), accepted_by: userId })
      .where("id", "=", invite.id).where("accepted_at", "is", null).where("revoked_at", "is", null).where("expires_at", ">", new Date())
      .returning(["role", "email"]).executeTakeFirst();
    if (!row) return undefined;
    await s.db.insertInto("memberships").values({ account_id: invite.accountId, user_id: userId, role: row.role })
      .onConflict((oc) => oc.columns(["account_id", "user_id"]).doNothing()).execute();
    return row;
  });
  if (!role) throw new ApiError(410, "invite_invalid", "This invite has already been used, was revoked or has expired.");
  await audit.write({ accountId: invite.accountId, actor: `user:${userId}`, action: "invite.accepted", target: invite.id, status: 200, details: { email: role.email, role: role.role } });
}

export function registerTeamRoutes(app: FastifyInstance, deps: { data: DataAccess; audit: AuditLog; config: TeamConfig; sessionDays: number }) {
  const { data, audit, config } = deps;
  const inviteAllowed = limiter(config.invitesPerHour, 3600_000);
  const userOnly = (req: FastifyRequest) => {
    if (!req.access?.userId) throw new ApiError(403, "forbidden", "This needs a signed-in console session, not an API key.");
    return req.access.userId;
  };
  const write = (req: FastifyRequest, action: string, target: string, details?: Record<string, unknown>) =>
    audit.write({ accountId: req.accountId!, actor: req.access!.actor, action, target, status: 200, details }).catch((err) => app.log.warn({ err }, "audit write failed"));

  // --- me ----------------------------------------------------------------------
  app.get("/v1/me", async (req) => {
    const account = await data.withAccount(req.accountId!, (s) => s.account.get());
    const acc = { id: account!.id, name: account!.name, time_zone: account!.time_zone };
    const userId = req.access?.userId;
    if (!userId) return { user: null, role: "owner", account: acc, memberships: [] };
    const user = await data.db().selectFrom("users").select(["id", "email", "name"]).where("id", "=", userId).executeTakeFirstOrThrow();
    const ms = await data.membershipsOf(userId);
    return {
      user: { id: user.id, email: user.email, name: user.name },
      role: req.access!.role,
      account: acc,
      memberships: ms.map((m) => ({ account: { id: m.accountId, name: m.accountName }, role: m.role })),
    };
  });

  app.patch<{ Body: { name: string | null } }>("/v1/me", {
    schema: { body: { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: ["string", "null"], maxLength: 100 } } } },
  }, async (req) => {
    const userId = userOnly(req);
    const name = req.body.name?.trim() || null;
    const u = await data.db().updateTable("users").set({ name }).where("id", "=", userId).returning(["id", "email", "name"]).executeTakeFirstOrThrow();
    return { id: u.id, email: u.email, name: u.name };
  });

  // Swaps the current session for one in another workspace the user belongs to.
  app.post<{ Body: { account_id: string } }>("/v1/me/switch", {
    schema: { body: { type: "object", required: ["account_id"], additionalProperties: false, properties: { account_id: { type: "string", maxLength: 64 } } } },
  }, async (req) => {
    const userId = userOnly(req);
    const target = (await data.membershipsOf(userId)).find((m) => m.accountId === req.body.account_id);
    if (!target) throw new ApiError(404, "not_found", "You're not a member of that workspace.");
    const s = await createSession(data, target.accountId, userId, deps.sessionDays);
    if (target.accountId !== req.accountId) {
      await data.withAccount(req.accountId!, (sc) => sc.db.updateTable("api_keys").set({ revoked_at: new Date() })
        .where("key_hash", "=", req.access!.keyHash!).where("user_id", "=", userId).execute());
    }
    void write(req, "workspace.switched", target.accountId);
    return s;
  });

  // --- members -----------------------------------------------------------------
  const listMembers = (accountId: string) => data.withAccount(accountId, (s) =>
    s.db.selectFrom("memberships").innerJoin("users", "users.id", "memberships.user_id")
      .select(["users.id", "users.email", "users.name", "memberships.role", "memberships.created_at"])
      .orderBy("memberships.created_at").orderBy("users.id").execute());
  const toMember = (m: { id: string; email: string; name: string | null; role: Role; created_at: Date }) =>
    ({ id: m.id, email: m.email, name: m.name, role: m.role, joined_at: iso(m.created_at) });

  app.get("/v1/members", async (req) => ({ data: (await listMembers(req.accountId!)).map(toMember), next_cursor: null }));

  /** Locks the account's memberships, checks owner rules and the last owner, then runs fn. */
  const changeMember = async <T>(req: FastifyRequest, userId: string, next: Role | null, fn: (s: AccountScope, from: Role) => Promise<T>) => {
    const mine = actorRole(req);
    return data.withAccount(req.accountId!, async (s) => {
      const rows = await s.db.selectFrom("memberships").select(["user_id", "role"]).forUpdate().execute();
      const target = rows.find((r) => r.user_id === userId);
      if (!target) throw new ApiError(404, "not_found", "member not found");
      if ((target.role === "owner" || next === "owner") && mine !== "owner") {
        throw new ApiError(403, "forbidden_role", "Only an owner can change owners.", { role: mine, required: "owner" });
      }
      if (target.role === "owner" && next !== "owner" && rows.filter((r) => r.role === "owner").length === 1) {
        throw new ApiError(409, "conflict", "A workspace needs at least one owner. Make someone else an owner first.", { reason: "last_owner" });
      }
      return fn(s, target.role);
    });
  };

  app.patch<{ Params: { id: string }; Body: { role: Role } }>("/v1/members/:id", {
    schema: { body: { type: "object", required: ["role"], additionalProperties: false, properties: { role: { type: "string", enum: ["owner", "admin", "member", "viewer"] } } } },
  }, async (req) => {
    const from = await changeMember(req, req.params.id, req.body.role, async (s, was) => {
      await s.db.updateTable("memberships").set({ role: req.body.role }).where("user_id", "=", req.params.id).execute();
      return was;
    });
    void write(req, "member.role_changed", req.params.id, { from, to: req.body.role });
    return toMember((await listMembers(req.accountId!)).find((m) => m.id === req.params.id)!);
  });

  app.delete<{ Params: { id: string } }>("/v1/members/:id", async (req, reply) => {
    const self = req.params.id === req.access?.userId;
    if (!self && !atLeast(actorRole(req), "admin")) {
      throw new ApiError(403, "forbidden_role", "Only an admin can remove someone else.", { role: actorRole(req), required: "admin" });
    }
    await changeMember(req, req.params.id, null, async (s) => {
      await s.db.deleteFrom("memberships").where("user_id", "=", req.params.id).execute();
      // Their sessions in this workspace end now (they also stop authenticating without a membership).
      await s.db.updateTable("api_keys").set({ revoked_at: new Date() }).where("user_id", "=", req.params.id).where("revoked_at", "is", null).execute();
    });
    await data.db().updateTable("users").set({ account_id: null }).where("id", "=", req.params.id).where("account_id", "=", req.accountId!).execute();
    void write(req, self ? "member.left" : "member.removed", req.params.id);
    return reply.code(204).send();
  });

  // --- invites -----------------------------------------------------------------
  type InviteRow = { id: string; email: string; role: Role; invited_by: string; created_at: Date; expires_at: Date; accepted_at: Date | null; revoked_at: Date | null };
  const toInvite = (i: InviteRow) => ({
    id: i.id, email: i.email, role: i.role, status: inviteStatus(i), invited_by: i.invited_by,
    created_at: iso(i.created_at), expires_at: iso(i.expires_at),
  });

  app.post<{ Body: { email: string; role: Role } }>("/v1/invites", {
    schema: { body: { type: "object", required: ["email", "role"], additionalProperties: false, properties: {
      email: { type: "string", format: "email", maxLength: 254 }, role: { type: "string", enum: ["owner", "admin", "member", "viewer"] },
    } } },
  }, async (req, reply) => {
    if (req.body.role === "owner" && actorRole(req) !== "owner") {
      throw new ApiError(403, "forbidden_role", "Only an owner can invite another owner.", { role: actorRole(req), required: "owner" });
    }
    if (!inviteAllowed(req.accountId!)) throw new ApiError(429, "rate_limited", "Too many invites this hour. Try again later.");
    const email = req.body.email.trim().toLowerCase();
    const token = `inv_${randomBytes(24).toString("base64url")}`;
    const invitedBy = req.access?.userId
      ? (await data.db().selectFrom("users").select("email").where("id", "=", req.access.userId).executeTakeFirst())?.email ?? req.access.actor
      : "API key";
    const row = await data.withAccount(req.accountId!, async (s) => {
      const member = await s.db.selectFrom("memberships").innerJoin("users", "users.id", "memberships.user_id")
        .select("users.id").where("users.email", "=", email).executeTakeFirst();
      if (member) throw new ApiError(409, "conflict", "That person is already in this workspace.", { reason: "already_member" });
      // A new invite to the same address replaces any earlier one.
      await s.db.updateTable("invites").set({ revoked_at: new Date() })
        .where("email", "=", email).where("accepted_at", "is", null).where("revoked_at", "is", null).execute();
      return s.db.insertInto("invites").values({
        id: newId("inv"), account_id: req.accountId!, email, role: req.body.role, token_hash: hashApiKey(token), invited_by: invitedBy,
        expires_at: new Date(Date.now() + config.inviteDays * 86400_000),
      }).returningAll().executeTakeFirstOrThrow();
    });
    void write(req, "invite.created", row.id, { email, role: row.role });
    return reply.code(201).send({ ...toInvite(row), invite_url: `${config.consoleUrl}/#invite=${token}` });
  });

  app.get("/v1/invites", async (req) => {
    const rows = await data.withAccount(req.accountId!, (s) => s.db.selectFrom("invites").selectAll()
      .where("accepted_at", "is", null).where("revoked_at", "is", null).orderBy("created_at", "desc").limit(200).execute());
    return { data: rows.map(toInvite), next_cursor: null };
  });

  app.delete<{ Params: { id: string } }>("/v1/invites/:id", async (req, reply) => {
    const r = await data.withAccount(req.accountId!, (s) => s.db.updateTable("invites").set({ revoked_at: new Date() })
      .where("id", "=", req.params.id).where("accepted_at", "is", null).where("revoked_at", "is", null).executeTakeFirst());
    if (!Number(r.numUpdatedRows)) throw new ApiError(404, "not_found", "invite not found");
    void write(req, "invite.revoked", req.params.id);
    return reply.code(204).send();
  });
}
