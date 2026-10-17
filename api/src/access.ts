// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// What the caller may see (ADR 0024). Account keys see everything (no
// `grants`); agent keys see the union of their grants: sources × senses ×
// an optional time window.
import type { FastifyRequest } from "fastify";
import { type ExpressionBuilder, sql } from "kysely";
import type { Role } from "./data/schema.js";
import { ApiError } from "./errors.js";

export interface Grant {
  source_ids: string[];
  senses: string[];
  window_from: Date | null;
  window_to: Date | null;
  /** `watch` and/or `history` (ADR 0048); absent means both. */
  abilities?: string[];
}

export const ABILITIES = ["watch", "history"] as const;
/** Without the `history` ability, recorded data is limited to this recent stretch (enough for listen and read_environment). */
export const RECENT_MS = 2 * 3600_000;
const has = (g: Grant, ability: (typeof ABILITIES)[number]) => !g.abilities || g.abilities.includes(ability);
export interface Access {
  actor: string;
  agentId?: string;
  /** Undefined for account keys (full access). */
  grants?: Grant[];
  /** SHA-256 of the API key used; media links carry it sealed so revocation reaches them (ADR 0036). */
  keyHash?: string;
  /** Console sessions: the signed-in user and their role in this account (ADR 0044). */
  userId?: string;
  role?: Role;
  /** Sensor integration tokens (ADR 0045): the one source they may push readings to. */
  integrationSource?: string;
}

/** Senses one grant covers for a whole time range on a source (union over grants); "all" for account keys. */
export function sensesForRange(grants: Grant[] | undefined, sourceId: string, from: Date, to: Date): Set<string> | "all" {
  if (!grants) return "all";
  const out = new Set<string>();
  for (const g of grants) if (g.source_ids.includes(sourceId) && inWindow(g, from) && inWindow(g, to)) g.senses.forEach((s) => out.add(s));
  return out;
}

/** Clamps [from, to] to the union of a sense's grant windows; undefined when no grant covers any of it. */
export function grantWindowsFor(grants: Grant[] | undefined, sourceId: string, sense: string): { from: Date | null; to: Date | null }[] | "all" {
  if (!grants) return "all";
  return grants.filter((g) => g.source_ids.includes(sourceId) && g.senses.includes(sense)).map((g) => ({ from: g.window_from, to: g.window_to }));
}

declare module "fastify" {
  interface FastifyRequest {
    access?: Access;
  }
}

const inWindow = (g: Grant, at: Date) => (!g.window_from || at >= g.window_from) && (!g.window_to || at <= g.window_to);

/** Senses granted on a source, at a time (default now); "all" for account keys. */
export function sensesAt(req: FastifyRequest, sourceId: string, at = new Date()): Set<string> | "all" {
  const grants = req.access?.grants;
  if (!grants) return "all";
  const out = new Set<string>();
  for (const g of grants) if (g.source_ids.includes(sourceId) && inWindow(g, at)) g.senses.forEach((s) => out.add(s));
  return out;
}

/** Any sense, at any time: may the caller know this source exists? */
export function seesSource(req: FastifyRequest, sourceId: string): boolean {
  const grants = req.access?.grants;
  return !grants || grants.some((g) => g.source_ids.includes(sourceId));
}

export function canSense(req: FastifyRequest, sourceId: string, sense: string, at = new Date()): boolean {
  const s = sensesAt(req, sourceId, at);
  return s === "all" || s.has(sense);
}

export function requireSense(req: FastifyRequest, sourceId: string, sense: string, at = new Date()) {
  if (!seesSource(req, sourceId)) throw new ApiError(404, "not_found", "source not found");
  if (!canSense(req, sourceId, sense, at)) throw new ApiError(403, "forbidden_sense", `this agent has no ${sense} grant for this source${at.getTime() !== Date.now() ? " at that time" : ""}`);
}

/** A recorded range must sit inside one grant's window for that sense. */
export function requireRange(req: FastifyRequest, sourceId: string, sense: string, from: Date, to: Date) {
  const grants = req.access?.grants;
  if (!grants) return;
  if (!seesSource(req, sourceId)) throw new ApiError(404, "not_found", "source not found");
  const ok = grants.some((g) => g.source_ids.includes(sourceId) && g.senses.includes(sense) && inWindow(g, from) && inWindow(g, to));
  if (!ok) throw new ApiError(403, "forbidden_sense", `this agent has no ${sense} grant covering that range`);
}

/** Kysely filter for rows with source_id, sense and a time column (events). */
export function grantFilter<DB, TB extends keyof DB>(req: FastifyRequest, timeColumn: string) {
  const grants = req.access?.grants;
  if (!grants) return undefined;
  return (eb: ExpressionBuilder<DB, TB>) => {
    if (!grants.length) return sql<boolean>`false`;
    return eb.or(grants.map((g) => {
      const parts = [eb("source_id" as never, "in", g.source_ids as never), eb("sense" as never, "in", g.senses as never)];
      if (g.window_from) parts.push(eb(timeColumn as never, ">=", g.window_from as never));
      if (g.window_to) parts.push(eb(timeColumn as never, "<=", g.window_to as never));
      return eb.and(parts);
    }));
  };
}

/** Routes an agent key may call; everything else is owner-only. */
const AGENT_ROUTES = new Set([
  "GET /v1/sources", "GET /v1/sources/:id", "GET /v1/sources/:id/now", "POST /v1/sources/:id/ask",
  "GET /v1/sources/:id/playback", "GET /v1/sources/:id/timeline", "GET /v1/sources/:id/history", "POST /v1/sources/:id/live",
  "GET /v1/events", "GET /v1/events/:id", "POST /v1/events/:id/feedback", "GET /v1/memory/search",
  "GET /v1/watches", "POST /v1/watches", "GET /v1/watches/:id", "PATCH /v1/watches/:id", "DELETE /v1/watches/:id",
  "GET /v1/clips", "POST /v1/clips", "GET /v1/clips/:id",
  // Conversations: an agent sees only its own, and answers use only its grants (ADR 0041).
  "POST /v1/conversations", "GET /v1/conversations", "GET /v1/conversations/:id", "DELETE /v1/conversations/:id", "POST /v1/conversations/:id/messages",
  "POST /v1/conversations/:id/messages/:mid/feedback",
  // Watch destinations (ADR 0043): backtests and the agent's own inbox.
  "POST /v1/watches/test", "GET /v1/inbox", "POST /v1/inbox/seen",
]);

/** Agent routes that need the `watch` ability on a grant (ADR 0048). */
const WATCH_ROUTES = new Set(["POST /v1/watches", "PATCH /v1/watches/:id", "DELETE /v1/watches/:id", "POST /v1/watches/test"]);
/** Agent routes over recorded data: grants without `history` only reach the last RECENT_MS (ADR 0048). */
const HISTORY_ROUTES = new Set([
  "GET /v1/events", "GET /v1/events/:id", "POST /v1/events/:id/feedback", "GET /v1/memory/search",
  "GET /v1/sources/:id/playback", "GET /v1/sources/:id/timeline", "GET /v1/sources/:id/history",
  "GET /v1/clips", "POST /v1/clips", "GET /v1/clips/:id",
  "POST /v1/conversations", "GET /v1/conversations", "GET /v1/conversations/:id", "POST /v1/conversations/:id/messages",
]);

/**
 * Narrows an agent's grants to what this route may use: only grants with
 * `watch` for watch changes, and for recorded data the grants without
 * `history` clamped to the recent stretch. Everything downstream (filters,
 * ranges, media links) then applies the narrowed grants.
 */
function grantsForRoute(route: string, grants: Grant[]): Grant[] {
  if (WATCH_ROUTES.has(route)) {
    const g = grants.filter((x) => has(x, "watch"));
    if (!g.length) throw new ApiError(403, "forbidden", "this agent isn't allowed to set watches; give it the watch permission on the Agents page");
    return g;
  }
  if (HISTORY_ROUTES.has(route)) {
    const since = new Date(Date.now() - RECENT_MS);
    return grants.map((g) => (has(g, "history") ? g : { ...g, window_from: g.window_from && g.window_from > since ? g.window_from : since }));
  }
  return grants;
}

/** Per-route checks that need only the path: owner-only routes and per-source senses. */
export function checkRoute(req: FastifyRequest) {
  const route = `${req.method} ${req.routeOptions.url}`;
  const integration = req.access?.integrationSource;
  if (integration) {
    // An integration token pushes readings to its own source and reads that source; nothing else.
    const id = (req.params as { id?: string }).id;
    if (route === "GET /v1/integration") return;
    if ((route === "POST /v1/sources/:id/readings" || route === "GET /v1/sources/:id") && id === integration) return;
    throw new ApiError(403, "forbidden", "an integration token can only push readings to its own source");
  }
  if (!req.access?.grants) return;
  if (!AGENT_ROUTES.has(route)) throw new ApiError(403, "forbidden", "agent keys can't use this endpoint; use an account key");
  req.access.grants = grantsForRoute(route, req.access.grants);
  const id = (req.params as { id?: string }).id;
  if (!id || !req.routeOptions.url?.startsWith("/v1/sources/:id")) return;
  if (!seesSource(req, id)) throw new ApiError(404, "not_found", "source not found");
  const q = req.query as { from?: string; to?: string; sense?: string };
  switch (req.routeOptions.url) {
    case "/v1/sources/:id/ask":
    case "/v1/sources/:id/live":
      return requireSense(req, id, "video");
    case "/v1/sources/:id/playback":
    case "/v1/sources/:id/timeline":
      if (q.from && q.to) return requireRange(req, id, "video", new Date(q.from), new Date(q.to));
      return requireSense(req, id, "video");
    case "/v1/sources/:id/history":
      if (q.sense) return requireSense(req, id, q.sense, q.from ? new Date(q.from) : new Date());
      return;
  }
}
