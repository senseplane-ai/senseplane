// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Rate limits and /metrics protection (ADR 0040).
//
// Fixed one-minute windows, per API key (hashed) for authenticated calls and
// per client IP otherwise. Expensive routes (watch compiles, ask, memory
// search) have their own smaller bucket. Limits are per process: behind a load
// balancer the effective limit is the per-process limit times the replicas.
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./errors.js";
import { isProduction } from "./ingest.js";

export interface RateLimits {
  /** Requests per minute per key (or per IP without a key); 0 turns limiting off. */
  perMinute: number;
  /** Per key per minute for expensive routes (LLM or embedding calls). */
  expensivePerMinute: number;
  /** Per IP per minute for unauthenticated routes (capture join, playback, media, OAuth). */
  anonymousPerMinute: number;
}

export function rateLimitsFromEnv(env = process.env): RateLimits {
  const n = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));
  return {
    perMinute: n(env.RATE_LIMIT_PER_MINUTE, 600),
    expensivePerMinute: n(env.RATE_LIMIT_EXPENSIVE_PER_MINUTE, 30),
    anonymousPerMinute: n(env.RATE_LIMIT_ANONYMOUS_PER_MINUTE, 600),
  };
}

const EXPENSIVE = new Set(["POST /v1/watches", "PATCH /v1/watches/:id", "POST /v1/sources/:id/ask", "GET /v1/memory/search", "POST /v1/conversations/:id/messages"]);

export function createLimiter() {
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = Date.now();
  return {
    /** Counts one hit; returns seconds until the window resets when over the limit, else 0. */
    hit(key: string, limit: number, now = Date.now()): number {
      if (limit <= 0) return 0;
      if (now - lastSweep > 60_000) {
        for (const [k, w] of windows) if (now - w.start >= 60_000) windows.delete(k);
        lastSweep = now;
      }
      let w = windows.get(key);
      if (!w || now - w.start >= 60_000) {
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      w.count++;
      return w.count > limit ? Math.ceil((w.start + 60_000 - now) / 1000) : 0;
    },
  };
}

const bearerId = (req: FastifyRequest) => {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) return undefined;
  return createHash("sha256").update(h.slice(7).trim()).digest("hex").slice(0, 24);
};

/** Registers the limiter as the first onRequest hook, before authentication. */
export function registerRateLimits(app: FastifyInstance, limits = rateLimitsFromEnv()) {
  const limiter = createLimiter();
  app.addHook("onRequest", async (req, reply) => {
    // The media plane's callbacks carry a signed token per room or feed and arrive every second per camera (ADR 0049).
    if (req.url === "/healthz" || req.url.startsWith("/internal/media/")) return;
    const key = bearerId(req);
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    const checks: [string, number][] = key
      ? [[`k:${key}`, limits.perMinute], ...(EXPENSIVE.has(route) ? [[`x:${key}`, limits.expensivePerMinute] as [string, number]] : [])]
      : [[`ip:${req.ip}`, limits.anonymousPerMinute]];
    for (const [bucket, limit] of checks) {
      const retry = limiter.hit(bucket, limit);
      if (retry) {
        reply.header("retry-after", String(retry));
        throw new ApiError(429, "rate_limited", "Too many requests; slow down and retry later.");
      }
    }
  });
}

/**
 * /metrics is for the operator, not the internet: with
 * METRICS_TOKEN set it needs `Authorization: Bearer <token>`; in production
 * without a token it is not served on the public listener.
 */
export function metricsAllowed(req: FastifyRequest, env = process.env): boolean {
  const token = env.METRICS_TOKEN;
  if (token) return req.headers.authorization === `Bearer ${token}`;
  return !isProduction(env);
}

/** Trust proxy setting: explicit proxy CIDRs or a hop count, never "trust everyone". */
export function trustProxyFromEnv(env = process.env): string[] | ((address: string, hop: number) => boolean) | false {
  const list = (env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  const hops = Number(env.TRUST_PROXY);
  // TRUST_PROXY=<n>: trust exactly the n nearest hops (e.g. 1 for a single reverse proxy).
  return Number.isInteger(hops) && hops > 0 ? (_address: string, hop: number) => hop < hops : false;
}

/** A small fixed-window limiter in this process (sign-in attempts per IP, invites per account). */
export function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; until: number }>();
  return (key: string) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.until < now) {
      hits.set(key, { n: 1, until: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.until < now) hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= max;
  };
}
