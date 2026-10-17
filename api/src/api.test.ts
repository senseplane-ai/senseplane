// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type ApiModule, type SenseplaneApi, type UsageRecord } from "./index.js";
import { createTestDatabase } from "./testdb.js";

describe("createApi", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  const usage: UsageRecord[] = [];

  const adminModule: ApiModule = {
    name: "test-admin",
    internalRoutes(app, ctx) {
      app.get("/admin/ping", { preHandler: ctx.auth.requireRole("operator") }, async () => ({ ok: true }));
      app.get("/admin/open", async () => ({ ok: true }));
    },
    async onUsage(r) {
      usage.push(r);
    },
    async quotaFor(accountId) {
      return accountId === "big" ? { maxSources: 100, maxRetentionDays: 30 } : undefined;
    },
  };

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, modules: [adminModule], internalPort: 0, logger: false });
  });

  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("serves /healthz and /metrics", async () => {
    expect((await api.public.inject("/healthz")).json()).toEqual({ status: "ok" });
    const m = await api.public.inject("/metrics");
    expect(m.statusCode).toBe(200);
    expect(m.body).toContain("senseplane_api_requests_total");
  });

  it("requires an API key on /v1 and answers unknown routes with not_implemented", async () => {
    const unauth = await api.public.inject("/v1/audit");
    expect(unauth.statusCode).toBe(401);
    expect(unauth.json().error).toMatchObject({ code: "unauthorized" });
    const account = await api.data.accounts.create("T");
    const { key } = await api.data.withAccount(account.id, (s) => s.apiKeys.create("test"));
    const r = await api.public.inject({ url: "/v1/not-a-route", headers: { authorization: `Bearer ${key}` } });
    expect(r.statusCode).toBe(501);
    expect(r.json().error).toMatchObject({ code: "not_implemented" });
    expect(r.json().error.request_id).toBe(r.headers["x-request-id"]);
  });

  it("mounts module internal routes only on the internal listener, failing closed on roles", async () => {
    expect((await api.public.inject("/admin/open")).statusCode).toBe(404);
    expect((await api.internal!.inject("/admin/open")).json()).toEqual({ ok: true });
    expect((await api.internal!.inject("/admin/ping")).statusCode).toBe(401);
  });

  it("forwards usage and quotas through module hooks", async () => {
    await api.recordUsage({ accountId: "a", kind: "vlm_calls", quantity: 1, at: new Date() });
    expect(usage).toHaveLength(1);
    expect((await api.quotaFor("big")).maxSources).toBe(100);
    expect((await api.quotaFor("small")).maxSources).toBeNull(); // unlimited by default (ADR 0025)
  });
});
