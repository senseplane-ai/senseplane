// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// AUTH_SIGNUP=first (the self-host compose file's setting): the first person
// to sign up owns the new workspace, then sign-up closes by itself; invites
// still work.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { authConfig } from "./routes/auth.js";
import { createTestDatabase } from "./testdb.js";

describe("authConfig", () => {
  it("reads AUTH_SIGNUP=first as open for the first user only", () => {
    expect(authConfig({ AUTH_SIGNUP: "first", SENSEPLANE_MODE: "production" })).toMatchObject({ signupOpen: true, signupFirstOnly: true });
    expect(authConfig({ AUTH_SIGNUP: "open" })).toMatchObject({ signupOpen: true, signupFirstOnly: false });
    expect(authConfig({ AUTH_SIGNUP: "closed" })).toMatchObject({ signupOpen: false });
    expect(authConfig({ SENSEPLANE_MODE: "production" })).toMatchObject({ signupOpen: false, signupFirstOnly: false });
  });
});

describe("first-user-only sign-up", () => {
  const drops: (() => Promise<void>)[] = [];
  const apis: SenseplaneApi[] = [];
  const PW = "correct horse battery";
  const cfg = { signupOpen: true, signupFirstOnly: true, password: true, consoleUrls: ["https://console.test"], sessionDays: 30, inviteDays: 7, attemptsPerMinute: 1000 };
  const fresh = async () => {
    const t = await createTestDatabase();
    drops.push(t.drop);
    const api = await createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", auth: cfg });
    apis.push(api);
    return api;
  };
  const signup = (api: SenseplaneApi, email: string) => api.public.inject({ method: "POST", url: "/auth/signup", payload: { email, password: PW } });
  const providers = async (api: SenseplaneApi) => (await api.public.inject({ url: "/auth/providers" })).json().signup as boolean;

  let api: SenseplaneApi;
  beforeAll(async () => {
    api = await fresh();
  });
  afterAll(async () => {
    for (const a of apis) await a.close();
    for (const d of drops) await d();
  });

  it("lets the first person sign up as owner, then closes; invites still work", async () => {
    expect(await providers(api)).toBe(true);
    const first = await signup(api, "owner@example.test");
    expect(first.statusCode).toBe(201);
    const { session } = first.json();
    const me = (await api.public.inject({ url: "/v1/me", headers: { authorization: `Bearer ${session}` } })).json();
    expect(me.role).toBe("owner");

    expect(await providers(api)).toBe(false);
    const second = await signup(api, "someone@example.test");
    expect(second.statusCode).toBe(403);
    expect(second.json().error.code).toBe("signup_refused");

    const inv = await api.public.inject({ method: "POST", url: "/v1/invites", headers: { authorization: `Bearer ${session}` }, payload: { email: "mate@example.test", role: "member" } });
    expect(inv.statusCode).toBe(201);
    const token = new URLSearchParams(new URL(inv.json().invite_url).hash.slice(1)).get("invite")!;
    const accepted = await api.public.inject({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { password: PW } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().account_id).toBe(first.json().account_id);
  });

  it("accepts exactly one of several simultaneous first sign-ups", async () => {
    const race = await fresh();
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => signup(race, `racer${i}@example.test`)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 403, 403, 403, 403]);
    const accounts = await race.data.db().selectFrom("users").select("id").execute();
    expect(accounts).toHaveLength(1);
  });
});
