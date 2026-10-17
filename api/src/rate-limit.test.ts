// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { errorBody } from "./errors.js";
import { ApiError } from "./errors.js";
import { createLimiter, metricsAllowed, registerRateLimits, trustProxyFromEnv } from "./rate-limit.js";

describe("rate limits and metrics", () => {
  it("counts per bucket per minute", () => {
    const l = createLimiter();
    const t = 1_000_000;
    expect([1, 2, 3].map(() => l.hit("k", 2, t))).toEqual([0, 0, 60]);
    expect(l.hit("other", 2, t)).toBe(0);
    expect(l.hit("k", 2, t + 60_001)).toBe(0); // next window
    expect(l.hit("k", 0, t)).toBe(0); // 0 = off
  });

  it("limits per key, with a smaller bucket for expensive routes", async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler((err, req, reply) => {
      if (err instanceof ApiError) return reply.code(err.status).send(errorBody(err.code, err.message, String(req.id)));
      return reply.code(500).send();
    });
    registerRateLimits(app, { perMinute: 5, expensivePerMinute: 2, anonymousPerMinute: 3 });
    app.get("/v1/sources", async () => ({ ok: true }));
    app.get("/v1/memory/search", async () => ({ ok: true }));
    const as = (key: string, url: string) => app.inject({ url, headers: { authorization: `Bearer ${key}` } });
    expect((await as("sk_a", "/v1/memory/search")).statusCode).toBe(200);
    expect((await as("sk_a", "/v1/memory/search")).statusCode).toBe(200);
    const third = await as("sk_a", "/v1/memory/search");
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("rate_limited");
    expect(third.headers["retry-after"]).toBeDefined();
    expect((await as("sk_b", "/v1/memory/search")).statusCode).toBe(200); // per key
    const anon = await Promise.all([1, 2, 3, 4].map(() => app.inject({ url: "/v1/sources" })));
    expect(anon.map((r) => r.statusCode)).toEqual([200, 200, 200, 429]);
    await app.close();
  });

  it("never trusts every proxy hop", () => {
    expect(trustProxyFromEnv({})).toBe(false);
    expect(trustProxyFromEnv({ TRUST_PROXY: "true" })).toBe(false);
    expect(trustProxyFromEnv({ TRUSTED_PROXIES: "10.0.0.0/8, 173.245.48.0/20" })).toEqual(["10.0.0.0/8", "173.245.48.0/20"]);
    const oneHop = trustProxyFromEnv({ TRUST_PROXY: "1" }) as (a: string, h: number) => boolean;
    expect([oneHop("x", 0), oneHop("x", 1)]).toEqual([true, false]);
  });

  it("hides /metrics in production unless a token is given", () => {
    const req = (auth?: string) => ({ headers: auth ? { authorization: auth } : {} }) as never;
    expect(metricsAllowed(req(), {})).toBe(true);
    expect(metricsAllowed(req(), { SENSEPLANE_MODE: "production" })).toBe(false);
    expect(metricsAllowed(req("Bearer t0k"), { SENSEPLANE_MODE: "production", METRICS_TOKEN: "t0k" })).toBe(true);
    expect(metricsAllowed(req("Bearer nope"), { METRICS_TOKEN: "t0k" })).toBe(false);
  });
});
