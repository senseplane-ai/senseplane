// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Workspace roles for console sessions (ADR 0044). API keys keep their own
// rules: account keys have full access, agent keys their grants (ADR 0024).
//
//   viewer  reads everything a console shows; changes nothing
//   member  also watches, clips, conversations, asking and event feedback
//   admin   everything else except deleting the workspace and owner changes
//   owner   everything
//
// Reads are open to viewers unless listed; writes need admin unless listed,
// so a route nobody classified fails closed.
import type { FastifyRequest } from "fastify";
import type { Role } from "./data/schema.js";
import { ApiError } from "./errors.js";

export type { Role };
export const ROLES: readonly Role[] = ["owner", "admin", "member", "viewer"];
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

/** Reads that reveal more than the console's screens: admin and up. */
const ADMIN_READS = new Set(["GET /v1/invites", "GET /v1/audit", "GET /v1/account/export/:id"]);

/** Writes a viewer may make: their own workspace session and watching live. */
const VIEWER_WRITES = new Set([
  "POST /v1/me/switch", "PATCH /v1/me", "DELETE /v1/members/:id", // leaving; the handler checks it is yourself
]);
/** Route prefixes for whole features: live view (viewer), conversations (member). */
const VIEWER_PREFIXES = ["POST /v1/sources/:id/live", "DELETE /v1/sources/:id/live"];
const MEMBER_PREFIXES = ["POST /v1/conversations", "PATCH /v1/conversations", "DELETE /v1/conversations"];
const under = (route: string, prefixes: string[]) => prefixes.some((p) => route === p || route.startsWith(`${p}/`));

/** Writes a member may make. */
const MEMBER_WRITES = new Set([
  "POST /v1/watches", "PATCH /v1/watches/:id", "DELETE /v1/watches/:id", "POST /v1/watches/test",
  "POST /v1/clips", "DELETE /v1/clips/:id",
  "POST /v1/events/:id/feedback", "POST /v1/sources/:id/ask",
]);

/** Owner only. */
const OWNER_WRITES = new Set(["DELETE /v1/account"]);

/** The lowest role that may call a route. */
export function requiredRole(method: string, url: string | undefined): Role {
  const route = `${method} ${url}`;
  if (method === "GET" || method === "HEAD") return ADMIN_READS.has(route.replace(/^HEAD/, "GET")) ? "admin" : "viewer";
  if (OWNER_WRITES.has(route)) return "owner";
  if (VIEWER_WRITES.has(route) || under(route, VIEWER_PREFIXES)) return "viewer";
  if (MEMBER_WRITES.has(route) || under(route, MEMBER_PREFIXES)) return "member";
  return "admin";
}

/** Refuses a console session whose role is below the route's (no-op for API keys). */
export function checkRole(req: FastifyRequest) {
  const role = req.access?.role;
  if (!role) return;
  const need = requiredRole(req.method, req.routeOptions.url);
  if (!atLeast(role, need)) {
    throw new ApiError(403, "forbidden_role", `Your role in this workspace (${role}) can't do this; it needs ${need} or above.`, { role, required: need });
  }
}
