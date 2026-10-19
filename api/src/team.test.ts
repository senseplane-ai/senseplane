// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { createPasswordUser } from "./routes/auth.js";
import { requiredRole } from "./roles.js";
import { createTestDatabase } from "./testdb.js";
import { sql } from "kysely";
import { Migrator } from "kysely/migration";
import { createDb } from "./data/db.js";
import { migrationProvider } from "./migrations/index.js";

const PW = "correct horse battery";
const settle = () => new Promise((r) => setTimeout(r, 200));

describe("teams, roles and invites (ADR 0044)", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let accountId: string;
  let apiKey: string;
  let owner: string;
  // Sign-up is closed: invited people may still sign up.
  const cfg = { signupOpen: false, password: true, github: { clientId: "gh", clientSecret: "s" }, consoleUrls: ["https://console.test"], sessionDays: 30, inviteDays: 7, attemptsPerMinute: 1000 };

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", auth: cfg,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } } as never,
      oauthClient: {
        authorizeUrl: (_p, _c, _r, state) => `https://idp.test/?state=${encodeURIComponent(state)}`,
        profile: async (p, _c, code) => ({ id: `${p}-${code}`, email: `${code}@example.test`, emailVerified: true }),
      },
    });
    const acc = await api.data.accounts.create("Northwind");
    accountId = acc.id;
    apiKey = (await api.data.withAccount(accountId, (s) => s.apiKeys.create("cli"))).key;
    await createPasswordUser(api.data, accountId, "owner@example.test", PW);
    owner = (await login("owner@example.test")).session;
  });
  afterAll(async () => {
    await settle(); // audit entries are written after each response
    await api?.close();
    await drop?.();
  });

  const call = (method: string, url: string, key: string, payload?: object) =>
    api.public.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload } : {}) });
  const login = async (email: string, password = PW) => {
    const r = await api.public.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    expect(r.statusCode).toBe(200);
    return r.json() as { session: string; account_id: string };
  };
  const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get("invite")!;
  /** Invites an email with a role and accepts as a new user; returns their session. */
  const join = async (email: string, role: string, by = owner) => {
    const inv = await call("POST", "/v1/invites", by, { email, role });
    expect(inv.statusCode).toBe(201);
    const r = await api.public.inject({ method: "POST", url: `/auth/invites/${tokenOf(inv.json().invite_url)}/accept`, payload: { password: PW, name: role } });
    expect(r.statusCode).toBe(200);
    return r.json().session as string;
  };
  const meId = async (key: string) => (await call("GET", "/v1/me", key)).json().user.id as string;

  it("makes the first user the owner and describes them at /v1/me", async () => {
    const me = (await call("GET", "/v1/me", owner)).json();
    expect(me).toMatchObject({ user: { email: "owner@example.test", name: null }, role: "owner", account: { id: accountId, name: "Northwind", time_zone: "UTC" } });
    expect(me.memberships).toEqual([{ account: { id: accountId, name: "Northwind" }, role: "owner" }]);
    // An API key acts as an owner and has no user.
    expect((await call("GET", "/v1/me", apiKey)).json()).toMatchObject({ user: null, role: "owner", account: { id: accountId } });
    expect((await call("PATCH", "/v1/me", owner, { name: "Alex Morgan" })).json()).toMatchObject({ name: "Alex Morgan" });
    expect((await call("PATCH", "/v1/me", apiKey, { name: "x" })).statusCode).toBe(403);
  });

  it("updates the workspace name and time zone", async () => {
    const r = await call("PATCH", "/v1/account", owner, { name: "Northwind Ops", time_zone: "Europe/Berlin" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ name: "Northwind Ops", time_zone: "Europe/Berlin" });
    expect((await call("PATCH", "/v1/account", owner, { time_zone: "Mars/Olympus" })).statusCode).toBe(400);
  });

  it("enforces each role on representative endpoints", async () => {
    const viewer = await join("viewer@example.test", "viewer");
    const member = await join("member@example.test", "member");
    const admin = await join("admin@example.test", "admin");
    const status = async (key: string, method: string, url: string, body?: object) => (await call(method, url, key, body)).statusCode;
    const refused = async (key: string, method: string, url: string, body?: object) => {
      const r = await call(method, url, key, body ?? {});
      expect(r.statusCode, `${method} ${url}`).toBe(403);
      expect(r.json().error.code).toBe("forbidden_role");
    };

    // Viewer: reads only.
    for (const url of ["/v1/sources", "/v1/watches", "/v1/events", "/v1/members", "/v1/account", "/v1/webhooks", "/v1/agents"]) {
      expect(await status(viewer, "GET", url), url).toBe(200);
    }
    await refused(viewer, "POST", "/v1/watches");
    await refused(viewer, "POST", "/v1/clips");
    await refused(viewer, "POST", "/v1/sources");
    await refused(viewer, "PATCH", "/v1/account", { name: "x" });
    await refused(viewer, "POST", "/v1/invites", { email: "x@example.test", role: "viewer" });
    await refused(viewer, "GET", "/v1/audit");
    await refused(viewer, "GET", "/v1/invites");

    // Member: watches, clips and asking (they reach validation), not keys, webhooks, team or settings.
    expect(await status(member, "POST", "/v1/watches", {})).toBe(400);
    expect(await status(member, "POST", "/v1/events/evt_x/feedback", {})).toBe(400);
    await refused(member, "POST", "/v1/agents", { name: "bot" });
    await refused(member, "POST", "/v1/webhooks", { url: "https://example.test/h", events: ["watch.triggered"] });
    await refused(member, "POST", "/v1/grants");
    await refused(member, "POST", "/v1/invites", { email: "x@example.test", role: "viewer" });
    await refused(member, "PATCH", `/v1/members/${await meId(viewer)}`, { role: "member" });
    await refused(member, "PATCH", "/v1/account", { time_zone: "UTC" });
    await refused(member, "POST", "/v1/account/export");

    // Admin: everything except deleting the workspace and owner changes.
    expect(await status(admin, "POST", "/v1/agents", { name: "bot" })).toBe(201);
    expect(await status(admin, "GET", "/v1/audit")).toBe(200);
    expect(await status(admin, "PATCH", "/v1/account", { time_zone: "UTC" })).toBe(200);
    expect((await call("PATCH", `/v1/members/${await meId(viewer)}`, admin, { role: "member" })).json()).toMatchObject({ role: "member" });
    await refused(admin, "DELETE", "/v1/account");
    await refused(admin, "PATCH", `/v1/members/${await meId(owner)}`, { role: "admin" });
    await refused(admin, "PATCH", `/v1/members/${await meId(member)}`, { role: "owner" });
    await refused(admin, "DELETE", `/v1/members/${await meId(owner)}`);
    await refused(admin, "POST", "/v1/invites", { email: "boss@example.test", role: "owner" });

    // Agent keys keep their own rules; account keys keep full access.
    expect(await status(apiKey, "GET", "/v1/audit")).toBe(200);
  });

  it("classifies routes it has never seen as admin-only writes", () => {
    expect(requiredRole("POST", "/v1/something-new")).toBe("admin");
    expect(requiredRole("GET", "/v1/something-new")).toBe("viewer");
    expect(requiredRole("POST", "/v1/conversations/:id/messages")).toBe("member");
    expect(requiredRole("POST", "/v1/sources/:id/live")).toBe("viewer");
    expect(requiredRole("DELETE", "/v1/account")).toBe("owner");
  });

  it("runs an invite's lifecycle: preview, single use, expiry, revocation, wrong email", async () => {
    const inv = (await call("POST", "/v1/invites", owner, { email: "Casey@Example.test", role: "member" })).json();
    expect(inv).toMatchObject({ email: "casey@example.test", role: "member", status: "pending", invited_by: "owner@example.test" });
    expect(inv.invite_url).toMatch(/^https:\/\/console\.test\/#invite=inv_/);
    const token = tokenOf(inv.invite_url);
    expect((await call("GET", "/v1/invites", owner)).json().data.map((i: { id: string }) => i.id)).toContain(inv.id);
    const preview = (await api.public.inject({ url: `/auth/invites/${token}` })).json();
    expect(preview).toMatchObject({ workspace: { name: "Northwind Ops" }, email: "casey@example.test", role: "member", existing_user: false });

    // Wrong email in the body, and a signed-in user with another address.
    const wrong = await api.public.inject({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { email: "eve@example.test", password: PW } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json().error.details.reason).toBe("wrong_email");
    const asOwner = await api.public.inject({ method: "POST", url: `/auth/invites/${token}/accept`, headers: { authorization: `Bearer ${owner}` }, payload: {} });
    expect(asOwner.statusCode).toBe(403);
    expect((await api.public.inject({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { password: "short" } })).statusCode).toBe(400);

    const ok = await api.public.inject({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { password: PW, name: "Casey" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().account_id).toBe(accountId);
    expect((await call("GET", "/v1/me", ok.json().session)).json()).toMatchObject({ user: { email: "casey@example.test", name: "Casey" }, role: "member" });

    // Single use.
    const again = await api.public.inject({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { password: PW } });
    expect(again.statusCode).toBe(410);
    expect(again.json().error).toMatchObject({ code: "invite_invalid", details: { reason: "accepted" } });
    expect((await call("GET", "/v1/invites", owner)).json().data.map((i: { id: string }) => i.id)).not.toContain(inv.id);
    expect((await call("POST", "/v1/invites", owner, { email: "casey@example.test", role: "viewer" })).json().error.details.reason).toBe("already_member");

    // Expired.
    const late = (await call("POST", "/v1/invites", owner, { email: "late@example.test", role: "viewer" })).json();
    await api.data.withAccount(accountId, (s) => s.db.updateTable("invites").set({ expires_at: new Date(Date.now() - 1000) }).where("id", "=", late.id).execute());
    const exp = await api.public.inject({ method: "POST", url: `/auth/invites/${tokenOf(late.invite_url)}/accept`, payload: { password: PW } });
    expect(exp.statusCode).toBe(410);
    expect(exp.json().error.details.reason).toBe("expired");
    expect((await call("GET", "/v1/invites", owner)).json().data.find((i: { id: string }) => i.id === late.id).status).toBe("expired");

    // Revoked, and re-inviting replaces the earlier link.
    const first = (await call("POST", "/v1/invites", owner, { email: "dana@example.test", role: "viewer" })).json();
    const second = (await call("POST", "/v1/invites", owner, { email: "dana@example.test", role: "member" })).json();
    expect((await api.public.inject({ url: `/auth/invites/${tokenOf(first.invite_url)}` })).json().error.details.reason).toBe("revoked");
    expect((await call("DELETE", `/v1/invites/${second.id}`, owner)).statusCode).toBe(204);
    expect((await call("DELETE", `/v1/invites/${second.id}`, owner)).statusCode).toBe(404);
    expect((await api.public.inject({ method: "POST", url: `/auth/invites/${tokenOf(second.invite_url)}/accept`, payload: { password: PW } })).statusCode).toBe(410);
    expect((await api.public.inject({ url: "/auth/invites/inv_nope" })).statusCode).toBe(404);

    // Audited.
    await settle();
    const actions = (await call("GET", "/v1/audit?limit=100", owner)).json().data.map((e: { action: string }) => e.action);
    for (const a of ["invite.created", "invite.accepted", "invite.revoked"]) expect(actions).toContain(a);
  });

  it("accepts an invite through GitHub even with sign-up closed, only for the invited address", async () => {
    const viaGithub = async (inviteUrl: string, code: string) => {
      const start = await api.public.inject({ url: `/auth/oauth/github/start?invite=${tokenOf(inviteUrl)}` });
      const state = new URL(start.headers.location as string).searchParams.get("state")!;
      const cb = await api.public.inject({ url: `/auth/oauth/github/callback?code=${code}&state=${encodeURIComponent(state)}` });
      return new URLSearchParams(new URL(cb.headers.location as string).hash.slice(1));
    };
    const inv = (await call("POST", "/v1/invites", owner, { email: "octo@example.test", role: "viewer" })).json();
    const ok = await viaGithub(inv.invite_url, "octo");
    expect(ok.get("account_id")).toBe(accountId);
    expect((await call("GET", "/v1/me", ok.get("session")!)).json()).toMatchObject({ user: { email: "octo@example.test" }, role: "viewer" });
    const other = (await call("POST", "/v1/invites", owner, { email: "zed@example.test", role: "viewer" })).json();
    const bad = await viaGithub(other.invite_url, "octo");
    expect(bad.get("auth_error")).toBe("forbidden");
    // Without an invite, a new GitHub user still can't sign up here.
    const start = await api.public.inject({ url: "/auth/oauth/github/start" });
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const cb = await api.public.inject({ url: `/auth/oauth/github/callback?code=stranger&state=${encodeURIComponent(state)}` });
    expect(new URL(cb.headers.location as string).hash).toContain("auth_error=signup_refused");
  });

  it("lets an existing user accept with their password or their session", async () => {
    const other = await api.data.accounts.create("Elsewhere");
    await createPasswordUser(api.data, other.id, "frank@example.test", PW);
    const inv = (await call("POST", "/v1/invites", owner, { email: "frank@example.test", role: "viewer" })).json();
    const token = tokenOf(inv.invite_url);
    expect((await api.public.inject({ url: `/auth/invites/${token}` })).json()).toMatchObject({ existing_user: true, has_password: true });
    expect((await api.public.inject({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { password: "wrong password!" } })).statusCode).toBe(401);
    const frank = await login("frank@example.test");
    const r = await api.public.inject({ method: "POST", url: `/auth/invites/${token}/accept`, headers: { authorization: `Bearer ${frank.session}` }, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json().account_id).toBe(accountId);
  });

  it("switches workspace for someone in several, and signs in to the last one used", async () => {
    const other = await api.data.accounts.create("Second site");
    await createPasswordUser(api.data, other.id, "gina@example.test", PW);
    const inv = (await call("POST", "/v1/invites", owner, { email: "gina@example.test", role: "member" })).json();
    const gina = await login("gina@example.test");
    expect(gina.account_id).toBe(other.id);
    await api.public.inject({ method: "POST", url: `/auth/invites/${tokenOf(inv.invite_url)}/accept`, payload: { password: PW } });

    const me = (await call("GET", "/v1/me", gina.session)).json();
    expect(me.role).toBe("owner");
    expect(me.memberships.map((m: { account: { id: string }; role: string }) => [m.account.id, m.role])).toEqual([[other.id, "owner"], [accountId, "member"]]);

    const sw = await call("POST", "/v1/me/switch", gina.session, { account_id: accountId });
    expect(sw.statusCode).toBe(200);
    expect(sw.json().account_id).toBe(accountId);
    expect((await call("GET", "/v1/me", sw.json().session)).json()).toMatchObject({ role: "member", account: { id: accountId } });
    expect((await call("GET", "/v1/me", gina.session)).statusCode).toBe(401); // the old session ended
    expect((await call("POST", "/v1/me/switch", sw.json().session, { account_id: "00000000-0000-0000-0000-000000000000" })).statusCode).toBe(404);
    expect((await call("POST", "/v1/me/switch", apiKey, { account_id: accountId })).statusCode).toBe(403);
    expect((await login("gina@example.test")).account_id).toBe(accountId);
  });

  it("protects the last owner and ends a removed member's sessions", async () => {
    const ownerId = await meId(owner);
    const last = await call("PATCH", `/v1/members/${ownerId}`, owner, { role: "admin" });
    expect(last.statusCode).toBe(409);
    expect(last.json().error).toMatchObject({ code: "conflict", details: { reason: "last_owner" } });
    expect((await call("DELETE", `/v1/members/${ownerId}`, owner)).statusCode).toBe(409);

    const heir = await join("heir@example.test", "admin");
    const heirId = await meId(heir);
    expect((await call("PATCH", `/v1/members/${heirId}`, owner, { role: "owner" })).json()).toMatchObject({ role: "owner" });
    expect((await call("PATCH", `/v1/members/${ownerId}`, owner, { role: "admin" })).json()).toMatchObject({ role: "admin" });
    expect((await call("GET", "/v1/me", owner)).json().role).toBe("admin"); // read on every request
    expect((await call("PATCH", `/v1/members/${ownerId}`, heir, { role: "owner" })).statusCode).toBe(200);

    // Anyone may leave; a removed member's session stops working at once.
    const temp = await join("temp@example.test", "viewer");
    expect((await call("DELETE", `/v1/members/${await meId(temp)}`, temp)).statusCode).toBe(204);
    expect((await call("GET", "/v1/sources", temp)).statusCode).toBe(401);
    const kicked = await join("kicked@example.test", "member");
    const kickedId = await meId(kicked);
    await refusedLeave(kicked, ownerId);
    expect((await call("DELETE", `/v1/members/${kickedId}`, heir)).statusCode).toBe(204);
    expect((await call("GET", "/v1/sources", kicked)).statusCode).toBe(401);
    // With no workspace left, sign-in says so.
    const r = await api.public.inject({ method: "POST", url: "/auth/login", payload: { email: "kicked@example.test", password: PW } });
    expect(r.statusCode).toBe(403);
    const members = (await call("GET", "/v1/members", owner)).json().data.map((m: { email: string }) => m.email);
    expect(members).not.toContain("kicked@example.test");
    const actions = (await call("GET", "/v1/audit?limit=100", owner)).json().data.map((e: { action: string }) => e.action);
    for (const a of ["member.role_changed", "member.removed", "member.left"]) expect(actions).toContain(a);
  });

  const refusedLeave = async (key: string, otherId: string) => {
    const r = await call("DELETE", `/v1/members/${otherId}`, key);
    expect(r.statusCode).toBe(403);
  };

  it("rate-limits invites per account", async () => {
    const t = await createTestDatabase();
    const small = await createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", auth: cfg, invitesPerHour: 2 });
    try {
      const acc = await small.data.accounts.create("Tiny");
      const key = (await small.data.withAccount(acc.id, (s) => s.apiKeys.create("cli"))).key;
      const post = (n: number) => small.public.inject({ method: "POST", url: "/v1/invites", headers: { authorization: `Bearer ${key}` }, payload: { email: `p${n}@example.test`, role: "viewer" } });
      expect((await post(1)).statusCode).toBe(201);
      expect((await post(2)).statusCode).toBe(201);
      expect((await post(3)).statusCode).toBe(429);
    } finally {
      await settle();
      await small.close();
      await t.drop();
    }
  }, 30_000); // a fresh database
  it("lets owners make workspace keys for their own apps, and nobody else", async () => {
    const admin = await join("keys-admin@example.test", "admin");
    expect((await call("POST", "/v1/keys", admin, { name: "My app" })).json().error.code).toBe("forbidden_role");
    expect((await call("GET", "/v1/keys", admin)).statusCode).toBe(200);
    const made = await call("POST", "/v1/keys", owner, { name: "My app" });
    expect(made.statusCode).toBe(201);
    const k = made.json();
    expect(k).toMatchObject({ name: "My app", key_prefix: k.api_key.slice(0, 7), last_used_at: null });
    // It adds cameras, which agent keys can't.
    expect((await call("POST", "/v1/sources", k.api_key, { name: "Shed", type: "browser" })).statusCode).toBe(201);
    const listed = (await call("GET", "/v1/keys", owner)).json().data.find((x: { id: string }) => x.id === k.id);
    expect(listed.api_key).toBeUndefined();
    expect(listed.last_used_at).not.toBeNull();
    // Console sessions and agent keys aren't workspace keys: neither listed nor revocable here.
    const ids = (await call("GET", "/v1/keys", owner)).json().data.map((x: { key_prefix: string }) => x.key_prefix);
    expect(ids).not.toContain(owner.slice(0, 7));
    expect((await call("DELETE", `/v1/keys/${k.id}`, admin)).statusCode).toBe(403);
    expect((await call("DELETE", `/v1/keys/${k.id}`, owner)).statusCode).toBe(204);
    expect((await call("GET", "/v1/sources", k.api_key)).statusCode).toBe(401);
  });
});

describe("migration 0020 on existing data", () => {
  it("makes existing users owners and keeps their single-user sessions", async () => {
    const t = await createTestDatabase();
    const owner = new URL(t.appUrl);
    const admin = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://senseplane:senseplane@localhost:55432/senseplane");
    owner.username = admin.username;
    owner.password = admin.password;
    const db = createDb(owner.toString(), 1);
    try {
      const migrator = new Migrator({ db, provider: migrationProvider });
      expect((await migrator.migrateTo("0019_watch_destinations")).error).toBeUndefined();
      const acc = "11111111-1111-1111-1111-111111111111";
      const two = "22222222-2222-2222-2222-222222222222";
      await sql`INSERT INTO accounts (id, name) VALUES (${acc}, 'Solo'), (${two}, 'Pair')`.execute(db);
      await sql`INSERT INTO users (id, account_id, email) VALUES ('usr_a', ${acc}, 'a@example.test'), ('usr_b', ${two}, 'b@example.test'), ('usr_c', ${two}, 'c@example.test')`.execute(db);
      await sql`INSERT INTO api_keys (id, account_id, key_hash, prefix, name) VALUES ('key_a', ${acc}, 'ha', 'sk_a', 'console session'), ('key_b', ${two}, 'hb', 'sk_b', 'console session'), ('key_c', ${two}, 'hc', 'sk_c', 'cli')`.execute(db);
      expect((await migrator.migrateToLatest()).error).toBeUndefined();
      const ms = (await sql<{ user_id: string; role: string }>`SELECT user_id, role FROM memberships ORDER BY user_id`.execute(db)).rows;
      expect(ms).toEqual([{ user_id: "usr_a", role: "owner" }, { user_id: "usr_b", role: "owner" }, { user_id: "usr_c", role: "owner" }]);
      const keys = (await sql<{ id: string; user_id: string | null; revoked: boolean }>`SELECT id, user_id, revoked_at IS NOT NULL AS revoked FROM api_keys ORDER BY id`.execute(db)).rows;
      expect(keys).toEqual([
        { id: "key_a", user_id: "usr_a", revoked: false }, // the account's only user
        { id: "key_b", user_id: null, revoked: true }, // two users: sign in again
        { id: "key_c", user_id: null, revoked: false }, // API keys untouched
      ]);
    } finally {
      await db.destroy();
      await t.drop();
    }
  }, 30_000);
});
