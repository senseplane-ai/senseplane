// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import type { ApiModule, SignupRequest } from "./module.js";
import type { OAuthClient } from "./routes/auth.js";
import { createTestDatabase } from "./testdb.js";

describe("console sign-in", () => {
  let api: SenseplaneApi;
  let closed: SenseplaneApi;
  const drops: (() => Promise<void>)[] = [];
  const seen: SignupRequest[] = [];
  const created: { id: string; plan?: string }[] = [];
  const policy: ApiModule = {
    name: "test-policy",
    async onSignup(r) {
      seen.push(r);
      if (r.email.endsWith("@blocked.test")) return { allow: false, message: "Not from this domain." };
      if (r.method === "github") return { allow: true, plan: "free" };
      return undefined;
    },
    async onAccountCreated(id, _r, plan) {
      created.push({ id, plan });
    },
  };
  const oauth: OAuthClient = {
    authorizeUrl: (p, _c, redirect, state) => `https://idp.test/${p}?redirect=${encodeURIComponent(redirect)}&state=${encodeURIComponent(state)}`,
    async profile(p, _c, code) {
      if (code === "bad") throw Object.assign(new Error("GitHub sign-in failed"), { code: "unauthorized" });
      return { id: `${p}-${code}`, email: `${code}@example.test`, emailVerified: true, login: code, createdAt: "2020-01-01T00:00:00Z", publicRepos: 3, followers: 1 };
    },
  };
  const cfg = { signupOpen: true, password: true, github: { clientId: "gh", clientSecret: "s" }, google: { clientId: "g", clientSecret: "s" }, consoleUrls: ["https://console.test"], sessionDays: 30 };

  beforeAll(async () => {
    const t = await createTestDatabase();
    drops.push(t.drop);
    api = await createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", modules: [policy], auth: cfg, oauthClient: oauth, apiPublicUrl: "https://api.test" });
    const t2 = await createTestDatabase();
    drops.push(t2.drop);
    closed = await createApi({ database: t2.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", auth: { ...cfg, signupOpen: false } });
  });
  afterAll(async () => {
    await api?.close();
    await closed?.close();
    for (const d of drops) await d();
  });
  const post = (a: SenseplaneApi, url: string, payload: object, headers: Record<string, string> = {}) => a.public.inject({ method: "POST", url, payload, headers });

  it("lists providers, and refuses sign-up when it is closed", async () => {
    expect((await api.public.inject({ url: "/auth/providers" })).json()).toMatchObject({ password: true, google: true, github: true, signup: true });
    const r = await post(closed, "/auth/signup", { email: "a@example.test", password: "correct horse battery" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("signup_refused");
  });

  it("signs up with a password, gets a working session, signs in and out", async () => {
    const s = await post(api, "/auth/signup", { email: "Ada@Example.test", password: "correct horse battery", device_token: "dev1" });
    expect(s.statusCode).toBe(201);
    const { session } = s.json();
    expect((await api.public.inject({ url: "/v1/account", headers: { authorization: `Bearer ${session}` } })).statusCode).toBe(200);
    expect(seen.at(-1)).toMatchObject({ method: "password", email: "ada@example.test", emailVerified: false, deviceToken: "dev1" });
    expect((await post(api, "/auth/signup", { email: "ada@example.test", password: "another long one" })).statusCode).toBe(409);
    expect((await post(api, "/auth/login", { email: "ada@example.test", password: "wrong password!" })).statusCode).toBe(401);
    const l = await post(api, "/auth/login", { email: "ADA@example.test", password: "correct horse battery" });
    expect(l.statusCode).toBe(200);
    const s2 = l.json().session;
    expect((await post(api, "/auth/logout", {}, { authorization: `Bearer ${s2}` })).statusCode).toBe(204);
    expect((await api.public.inject({ url: "/v1/account", headers: { authorization: `Bearer ${s2}` } })).statusCode).toBe(401);
    expect((await api.public.inject({ url: "/v1/account", headers: { authorization: `Bearer ${session}` } })).statusCode).toBe(200);
  });

  it("lets a module refuse a sign-up", async () => {
    const r = await post(api, "/auth/signup", { email: "x@blocked.test", password: "correct horse battery" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatchObject({ code: "signup_refused", message: "Not from this domain." });
  });

  it("stops accepting a session once it expires", async () => {
    const { session, account_id } = (await post(api, "/auth/signup", { email: "exp@example.test", password: "correct horse battery" })).json();
    await api.data.withAccount(account_id, (s) => s.db.updateTable("api_keys").set({ expires_at: new Date(Date.now() - 1000) }).where("name", "=", "console session").execute());
    expect((await api.public.inject({ url: "/v1/account", headers: { authorization: `Bearer ${session}` } })).statusCode).toBe(401);
  });

  it("signs up with GitHub through the hooks, then signs the same person in again", async () => {
    const start = await api.public.inject({ url: "/auth/oauth/github/start?return_to=https://console.test&device_token=dev2" });
    expect(start.statusCode).toBe(302);
    const to = new URL(start.headers.location as string);
    expect(to.searchParams.get("redirect")).toBe("https://api.test/auth/oauth/github/callback");
    const state = to.searchParams.get("state")!;
    const cb = await api.public.inject({ url: `/auth/oauth/github/callback?code=octo&state=${encodeURIComponent(state)}` });
    expect(cb.statusCode).toBe(302);
    const hash = new URLSearchParams(new URL(cb.headers.location as string).hash.slice(1));
    const session = hash.get("session")!;
    expect(session).toMatch(/^sk_/);
    expect(seen.at(-1)).toMatchObject({ method: "github", email: "octo@example.test", emailVerified: true, deviceToken: "dev2", provider: { name: "github", id: "github-octo", createdAt: "2020-01-01T00:00:00Z", publicRepos: 3 } });
    const acc = hash.get("account_id")!;
    expect(created.at(-1)).toEqual({ id: acc, plan: "free" });
    const account = (await api.public.inject({ url: "/v1/account", headers: { authorization: `Bearer ${session}` } })).json();
    expect(account.id).toBe(acc);
    expect(await api.data.withAccount(acc, (s) => s.db.selectFrom("accounts").select("plan").executeTakeFirst())).toEqual({ plan: "free" });

    const before = seen.length;
    const again = await api.public.inject({ url: `/auth/oauth/github/callback?code=octo&state=${encodeURIComponent(state)}` });
    const hash2 = new URLSearchParams(new URL(again.headers.location as string).hash.slice(1));
    expect(hash2.get("account_id")).toBe(acc);
    expect(seen.length).toBe(before); // no second sign-up
  });

  it("rejects a forged state and reports provider errors back to the console", async () => {
    const forged = await api.public.inject({ url: "/auth/oauth/github/callback?code=octo&state=nope" });
    expect(new URL(forged.headers.location as string).hash).toContain("auth_error=invalid_state");
    const start = await api.public.inject({ url: "/auth/oauth/google/start" });
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const bad = await api.public.inject({ url: `/auth/oauth/google/callback?code=bad&state=${encodeURIComponent(state)}` });
    expect(new URL(bad.headers.location as string).origin).toBe("https://console.test");
    expect(new URL(bad.headers.location as string).hash).toContain("auth_error=");
  });
});
