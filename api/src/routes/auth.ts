// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Console sign-in (ADR 0031): email and password, and "Continue with Google"
// or "Continue with GitHub" when their OAuth credentials are configured. A
// signed-in console gets a session: an API key that expires.
//
// Sign-up is open in development and closed in production unless AUTH_SIGNUP
// says otherwise: `open`, `closed`, or `first`, where only the first person to
// sign up does (they own the new workspace) and sign-up then closes by itself,
// as the self-host compose file sets it. Accounts can also come from the setup CLI. Modules decide
// each sign-up through `onSignup`. Invited people may always sign up: they
// join an existing workspace instead of creating one (ADR 0044).
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type DataAccess, hashApiKey } from "../data/access.js";
import { newId } from "../data/ids.js";
import type { Role } from "../data/schema.js";
import { ApiError } from "../errors.js";
import type { ApiModule, AuditLog, SignupRequest } from "../module.js";
import { isProduction } from "../ingest.js";
import { limiter } from "../rate-limit.js";
import { acceptInvite, createSession, inviteStatus, workspaceFor } from "./team.js";

/** Serialises sign-ups under AUTH_SIGNUP=first (arbitrary, constant). */
const FIRST_SIGNUP_LOCK = 0x5e76;

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function checkPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored?.startsWith("scrypt$")) {
    await scrypt(password, randomBytes(16), 64); // same work either way
    return false;
  }
  const [, salt, hash] = stored.split("$");
  const want = Buffer.from(hash!, "base64url");
  const got = await scrypt(password, Buffer.from(salt!, "base64url"), want.length);
  return timingSafeEqual(want, got);
}

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  signupOpen: boolean;
  /** With signupOpen: only while the instance has no users yet (AUTH_SIGNUP=first). */
  signupFirstOnly?: boolean;
  password: boolean;
  google?: OAuthProviderConfig;
  github?: OAuthProviderConfig;
  /** Console URLs the OAuth flow may return to (the first is the default). */
  consoleUrls: string[];
  sessionDays: number;
  /** Invite links stay valid this many days (default 7). */
  inviteDays: number;
  /** Sign-in, sign-up and invite attempts per IP per minute (default 10). */
  attemptsPerMinute?: number;
  /** Optional sign-up challenge shown by the console (e.g. a Turnstile site key); verified by a module. */
  challenge?: { provider: string; siteKey: string };
  /** This instance's public MCP base URL (MCP_PUBLIC_URL), for the console's connect instructions and consent page (ADR 0048). */
  mcpUrl?: string;
}

export function authConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const pair = (prefix: string) => (env[`${prefix}_CLIENT_ID`] && env[`${prefix}_CLIENT_SECRET`] ? { clientId: env[`${prefix}_CLIENT_ID`]!, clientSecret: env[`${prefix}_CLIENT_SECRET`]! } : undefined);
  return {
    // Unset: open outside production, so a local stack signs up like a real user (ADR 0044).
    signupOpen: env.AUTH_SIGNUP ? env.AUTH_SIGNUP === "open" || env.AUTH_SIGNUP === "first" : !isProduction(env),
    signupFirstOnly: env.AUTH_SIGNUP === "first",
    password: env.AUTH_PASSWORD !== "off",
    google: pair("AUTH_GOOGLE"),
    github: pair("AUTH_GITHUB"),
    consoleUrls: (env.CONSOLE_URL ?? "http://localhost:5173").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
    sessionDays: Number(env.AUTH_SESSION_DAYS ?? 30),
    inviteDays: Number(env.AUTH_INVITE_DAYS ?? 7),
    challenge: env.AUTH_CHALLENGE_SITE_KEY ? { provider: env.AUTH_CHALLENGE_PROVIDER ?? "turnstile", siteKey: env.AUTH_CHALLENGE_SITE_KEY } : undefined,
    mcpUrl: env.MCP_PUBLIC_URL?.trim().replace(/\/+$/, "") || undefined,
  };
}

interface ProviderProfile {
  id: string;
  email: string;
  emailVerified: boolean;
  login?: string;
  createdAt?: string;
  publicRepos?: number;
  followers?: number;
}

/** OAuth endpoints and profile fetches, injectable for tests. */
export interface OAuthClient {
  authorizeUrl(provider: "google" | "github", cfg: OAuthProviderConfig, redirectUri: string, state: string): string;
  profile(provider: "google" | "github", cfg: OAuthProviderConfig, code: string, redirectUri: string): Promise<ProviderProfile>;
}

export function httpOAuthClient(fetchImpl: typeof fetch = fetch): OAuthClient {
  const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
  return {
    authorizeUrl(provider, cfg, redirectUri, state) {
      if (provider === "google") {
        return `https://accounts.google.com/o/oauth2/v2/auth?${form({ client_id: cfg.clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, prompt: "select_account" })}`;
      }
      return `https://github.com/login/oauth/authorize?${form({ client_id: cfg.clientId, redirect_uri: redirectUri, scope: "read:user user:email", state, allow_signup: "false" })}`;
    },
    async profile(provider, cfg, code, redirectUri) {
      const timeout = () => AbortSignal.timeout(10_000);
      if (provider === "google") {
        const t = await fetchImpl("https://oauth2.googleapis.com/token", {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, signal: timeout(),
          body: form({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
        });
        if (!t.ok) throw new ApiError(401, "unauthorized", "Google sign-in failed");
        const { access_token } = (await t.json()) as { access_token: string };
        const u = await fetchImpl("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${access_token}` }, signal: timeout() });
        if (!u.ok) throw new ApiError(401, "unauthorized", "Google sign-in failed");
        const p = (await u.json()) as { sub: string; email?: string; email_verified?: boolean };
        if (!p.sub || !p.email) throw new ApiError(401, "unauthorized", "Google didn't share an email address");
        return { id: p.sub, email: p.email.toLowerCase(), emailVerified: p.email_verified === true };
      }
      const t = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, signal: timeout(),
        body: form({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri }),
      });
      const tok = (await t.json().catch(() => ({}))) as { access_token?: string };
      if (!t.ok || !tok.access_token) throw new ApiError(401, "unauthorized", "GitHub sign-in failed");
      const h = { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "Senseplane" };
      const u = await fetchImpl("https://api.github.com/user", { headers: h, signal: timeout() });
      if (!u.ok) throw new ApiError(401, "unauthorized", "GitHub sign-in failed");
      const p = (await u.json()) as { id: number; login: string; created_at?: string; public_repos?: number; followers?: number };
      const e = await fetchImpl("https://api.github.com/user/emails", { headers: h, signal: timeout() });
      const emails = e.ok ? ((await e.json()) as { email: string; primary: boolean; verified: boolean }[]) : [];
      const primary = emails.find((x) => x.primary && x.verified) ?? emails.find((x) => x.verified);
      if (!primary) throw new ApiError(401, "unauthorized", "Your GitHub account needs a verified email address");
      return { id: String(p.id), email: primary.email.toLowerCase(), emailVerified: true, login: p.login, createdAt: p.created_at, publicRepos: p.public_repos, followers: p.followers };
    },
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: {
  data: DataAccess; modules: ApiModule[]; config: AuthConfig; oauth: OAuthClient; publicBase: (req: FastifyRequest) => string; audit: AuditLog;
}) {
  const { data, config } = deps;
  const allow = limiter(config.attemptsPerMinute ?? 10, 60_000);
  const throttle = (req: FastifyRequest) => {
    if (!allow(req.ip)) throw new ApiError(429, "rate_limited", "Too many sign-in attempts. Wait a minute and try again.");
  };
  const providers = { google: config.google, github: config.github } as const;

  const session = (accountId: string, userId: string) => createSession(data, accountId, userId, config.sessionDays);
  /** A session in the user's last workspace (or their oldest). */
  const signIn = async (user: { id: string; account_id: string | null }) => session(await workspaceFor(data, user.id, user.account_id), user.id);

  /** A user with no workspace yet (sign-up adds one; an invite joins one). */
  const createUser = async (email: string, passwordHash: string | null, name: string | null, provider?: { name: string; id: string }) => {
    const id = newId("usr");
    await data.db().insertInto("users").values({ id, account_id: null, email, name, password_hash: passwordHash }).execute();
    if (provider) await data.db().insertInto("user_identities").values({ provider: provider.name, provider_user_id: provider.id, user_id: id, email }).execute();
    return id;
  };

  const closedMessage = "Sign-up is closed on this instance. Ask its owner for an invite.";
  const hasUsers = async () => !!(await data.db().selectFrom("users").select("id").limit(1).executeTakeFirst());
  /** Whether a sign-up would be accepted now (AUTH_SIGNUP=first closes it once anyone has signed up). */
  const signupOpen = async () => config.signupOpen && !(config.signupFirstOnly && (await hasUsers()));

  /** Runs the sign-up hooks, then creates the account, its owner and (optionally) an identity. */
  const signUp = async (r: SignupRequest, passwordHash: string | null, name?: string) => {
    if (!config.signupOpen) throw new ApiError(403, "signup_refused", closedMessage);
    if (!config.signupFirstOnly) return createWorkspace(r, passwordHash, name);
    // First user only: one sign-up at a time across API processes, and only while nobody has an account.
    return data.withAdvisoryLock(FIRST_SIGNUP_LOCK, async () => {
      if (await hasUsers()) throw new ApiError(403, "signup_refused", closedMessage);
      return createWorkspace(r, passwordHash, name);
    });
  };

  const createWorkspace = async (r: SignupRequest, passwordHash: string | null, name?: string) => {
    let plan: string | undefined;
    for (const m of deps.modules) {
      const d = await m.onSignup?.(r);
      if (!d) continue;
      if (!d.allow) throw new ApiError(403, "signup_refused", d.message);
      plan ??= d.plan;
    }
    const taken = await data.db().selectFrom("users").select("id").where("email", "=", r.email).executeTakeFirst();
    if (taken) throw new ApiError(409, "validation_failed", "An account with this email already exists. Sign in instead.");
    const account = await data.accounts.create(name?.trim() || r.email.split("@")[0]!, process.env.RAW_RETENTION_DAYS ? Number(process.env.RAW_RETENTION_DAYS) : undefined);
    if (plan) await data.withAccount(account.id, (s) => s.db.updateTable("accounts").set({ plan }).where("id", "=", account.id).execute());
    const userId = await createUser(r.email, passwordHash, null, r.provider);
    await data.withAccount(account.id, (s) => s.db.insertInto("memberships").values({ account_id: account.id, user_id: userId, role: "owner" }).execute());
    for (const m of deps.modules) await m.onAccountCreated?.(account.id, r, plan);
    return { accountId: account.id, userId };
  };

  const meta = (req: FastifyRequest, body?: { device_token?: string; challenge_token?: string }) => ({
    ip: req.ip, userAgent: req.headers["user-agent"], deviceToken: body?.device_token || undefined, challengeToken: body?.challenge_token || undefined,
  });

  app.get("/auth/providers", async () => ({
    password: config.password, google: !!config.google, github: !!config.github, signup: await signupOpen(),
    challenge: config.challenge ? { provider: config.challenge.provider, site_key: config.challenge.siteKey } : null,
    mcp_url: config.mcpUrl ?? null,
  }));

  type PwBody = { email: string; password: string; name?: string; device_token?: string; challenge_token?: string };
  const pwSchema = { body: { type: "object", required: ["email", "password"], properties: {
    email: { type: "string", format: "email", maxLength: 254 }, password: { type: "string", minLength: 10, maxLength: 200 },
    name: { type: "string", maxLength: 100 }, device_token: { type: "string", maxLength: 200 }, challenge_token: { type: "string", maxLength: 4096 },
  } } };

  app.post<{ Body: PwBody }>("/auth/signup", { schema: pwSchema }, async (req, reply) => {
    if (!config.password) throw new ApiError(403, "signup_refused", "Email sign-up is turned off on this instance.");
    throttle(req);
    const email = req.body.email.trim().toLowerCase();
    const u = await signUp({ method: "password", email, emailVerified: false, ...meta(req, req.body) }, await hashPassword(req.body.password), req.body.name);
    return reply.code(201).send(await session(u.accountId, u.userId));
  });

  app.post<{ Body: PwBody }>("/auth/login", { schema: { body: { ...pwSchema.body, properties: { ...pwSchema.body.properties, password: { type: "string", maxLength: 200 } } } } }, async (req) => {
    if (!config.password) throw new ApiError(403, "unauthorized", "Email sign-in is turned off on this instance.");
    throttle(req);
    const user = await data.db().selectFrom("users").select(["id", "account_id", "password_hash"]).where("email", "=", req.body.email.trim().toLowerCase()).executeTakeFirst();
    if (!(await checkPassword(req.body.password, user?.password_hash ?? null)) || !user) throw new ApiError(401, "unauthorized", "Wrong email or password.");
    return signIn(user);
  });

  app.post("/auth/logout", async (req, reply) => {
    const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    const p = key ? await data.authenticate(key) : undefined;
    if (p) {
      await data.withAccount(p.accountId, (s) => s.db.updateTable("api_keys").set({ revoked_at: new Date() })
        .where("key_hash", "=", hashApiKey(key)).where("name", "=", "console session").execute());
    }
    return reply.code(204).send();
  });



  // --- invites (ADR 0044) ------------------------------------------------------
  /** A pending invite by its token, with its workspace; refuses unknown, used, revoked and expired ones. */
  const pendingInvite = async (token: string) => {
    const found = token.startsWith("inv_") ? await data.inviteByTokenHash(hashApiKey(token)) : undefined;
    if (!found) throw new ApiError(404, "invite_invalid", "This invite link isn't valid.", { reason: "not_found" });
    const row = await data.withAccount(found.accountId, async (s) => ({
      invite: await s.db.selectFrom("invites").selectAll().where("id", "=", found.id).executeTakeFirstOrThrow(),
      account: (await s.account.get())!,
    }));
    const status = inviteStatus(row.invite);
    const why = { accepted: "This invite has already been used.", revoked: "This invite was withdrawn.", expired: "This invite has expired. Ask for a new one." } as const;
    if (status !== "pending") throw new ApiError(410, "invite_invalid", why[status], { reason: status });
    return { id: found.id, accountId: found.accountId, email: row.invite.email, role: row.invite.role, expiresAt: row.invite.expires_at, accountName: row.account.name };
  };

  // What the accept page shows, and whether to ask for a new password or the existing one.
  app.get<{ Params: { token: string } }>("/auth/invites/:token", async (req) => {
    throttle(req);
    const inv = await pendingInvite(req.params.token);
    const user = await data.db().selectFrom("users").select(["id", "password_hash"]).where("email", "=", inv.email).executeTakeFirst();
    return {
      workspace: { name: inv.accountName }, email: inv.email, role: inv.role, expires_at: new Date(inv.expiresAt).toISOString(),
      existing_user: !!user, has_password: !!user?.password_hash,
    };
  });

  // Signed in (Authorization: Bearer <session>) or not: signs in with the
  // password, or signs up when the address is new (even with sign-up closed),
  // then joins the workspace and returns a session in it.
  app.post<{ Params: { token: string }; Body: { email?: string; password?: string; name?: string } }>("/auth/invites/:token/accept", {
    schema: { body: { type: "object", additionalProperties: false, properties: {
      email: { type: "string", maxLength: 254 }, password: { type: "string", maxLength: 200 }, name: { type: "string", maxLength: 100 },
    } } },
  }, async (req) => {
    throttle(req);
    const inv = await pendingInvite(req.params.token);
    const wrongEmail = () => new ApiError(403, "forbidden", `This invite was sent to ${inv.email}. Sign in with that address to accept it.`, { reason: "wrong_email" });
    const body = req.body ?? {};
    if (body.email && body.email.trim().toLowerCase() !== inv.email) throw wrongEmail();
    const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    let userId: string;
    if (key) {
      const p = await data.authenticate(key);
      if (!p?.userId) throw new ApiError(401, "unauthorized", "Sign in again to accept this invite.");
      const me = await data.db().selectFrom("users").select("email").where("id", "=", p.userId).executeTakeFirstOrThrow();
      if (me.email !== inv.email) throw wrongEmail();
      userId = p.userId;
    } else {
      if (!config.password) throw new ApiError(403, "unauthorized", "Email sign-in is turned off on this instance; continue with Google or GitHub.");
      const password = body.password ?? "";
      const user = await data.db().selectFrom("users").select(["id", "password_hash"]).where("email", "=", inv.email).executeTakeFirst();
      if (user) {
        if (!(await checkPassword(password, user.password_hash))) throw new ApiError(401, "unauthorized", "Wrong email or password.");
        userId = user.id;
      } else {
        if (password.length < 10) throw new ApiError(400, "validation_failed", "Choose a password of at least 10 characters.");
        userId = await createUser(inv.email, await hashPassword(password), body.name?.trim() || null);
      }
    }
    await acceptInvite(data, deps.audit, inv, userId);
    return session(inv.accountId, userId);
  });

  const returnTo = (raw: string | undefined) => {
    const r = (raw ?? "").replace(/\/$/, "");
    return config.consoleUrls.includes(r) ? r : config.consoleUrls[0]!;
  };

  app.get<{ Params: { provider: string }; Querystring: { return_to?: string; device_token?: string; invite?: string } }>("/auth/oauth/:provider/start", async (req, reply) => {
    const provider = req.params.provider as "google" | "github";
    const cfg = providers[provider];
    if (!cfg) throw new ApiError(404, "not_found", "This sign-in provider isn't configured");
    const state = data.box().encrypt(JSON.stringify({
      p: provider, n: randomUUID(), exp: Date.now() + 10 * 60_000, rt: returnTo(req.query.return_to), dt: req.query.device_token?.slice(0, 200),
      iv: req.query.invite?.slice(0, 100),
    }));
    return reply.redirect(deps.oauth.authorizeUrl(provider, cfg, `${deps.publicBase(req)}/auth/oauth/${provider}/callback`, state), 302);
  });

  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>("/auth/oauth/:provider/callback", async (req, reply) => {
    const provider = req.params.provider as "google" | "github";
    const cfg = providers[provider];
    let st: { p: string; exp: number; rt: string; dt?: string; iv?: string } | undefined;
    try {
      st = JSON.parse(data.box().decrypt(req.query.state ?? ""));
    } catch {
      st = undefined;
    }
    const back = (hash: Record<string, string>) => reply.redirect(`${st?.rt ?? config.consoleUrls[0]}/#${new URLSearchParams(hash)}`, 302);
    if (!cfg || !st || st.p !== provider || st.exp < Date.now() || !req.query.state?.startsWith("enc:")) return back({ auth_error: "invalid_state", message: "Sign-in expired. Try again." });
    if (req.query.error || !req.query.code) return back({ auth_error: "cancelled", message: "Sign-in was cancelled." });
    try {
      throttle(req);
      const prof = await deps.oauth.profile(provider, cfg, req.query.code, `${deps.publicBase(req)}/auth/oauth/${provider}/callback`);
      const known = await data.db().selectFrom("user_identities").innerJoin("users", "users.id", "user_identities.user_id")
        .select(["users.id", "users.account_id"]).where("provider", "=", provider).where("provider_user_id", "=", prof.id).executeTakeFirst();
      // Same verified email as an existing user: link this provider to it.
      const byEmail = !known && prof.emailVerified ? await data.db().selectFrom("users").select(["id", "account_id"]).where("email", "=", prof.email).executeTakeFirst() : undefined;
      if (byEmail) {
        await data.db().insertInto("user_identities").values({ provider, provider_user_id: prof.id, user_id: byEmail.id, email: prof.email })
          .onConflict((oc) => oc.columns(["provider", "provider_user_id"]).doNothing()).execute();
      }
      let user = known ?? byEmail;
      if (st.iv) {
        // Accepting an invite: the provider must vouch for the invited address.
        const inv = await pendingInvite(st.iv);
        const email = user ? (await data.db().selectFrom("users").select("email").where("id", "=", user.id).executeTakeFirstOrThrow()).email : prof.email;
        if (email !== inv.email || (!user && !prof.emailVerified)) {
          return back({ auth_error: "forbidden", message: `This invite was sent to ${inv.email}. Sign in with that address to accept it.` });
        }
        user ??= { id: await createUser(inv.email, null, null, { name: provider, id: prof.id }), account_id: null };
        await acceptInvite(data, deps.audit, inv, user.id);
        return back(await session(inv.accountId, user.id) as unknown as Record<string, string>);
      }
      if (user) return back(await signIn(user) as unknown as Record<string, string>);
      const u = await signUp({
        method: provider, email: prof.email, emailVerified: prof.emailVerified, ip: req.ip, userAgent: req.headers["user-agent"], deviceToken: st.dt,
        provider: { name: provider, id: prof.id, login: prof.login, createdAt: prof.createdAt, publicRepos: prof.publicRepos, followers: prof.followers },
      }, null);
      return back(await session(u.accountId, u.userId) as unknown as Record<string, string>);
    } catch (e) {
      const err = e as ApiError;
      return back({ auth_error: err.code ?? "unauthorized", message: err.message ?? "Sign-in failed." });
    }
  });
}

/**
 * Adds a console sign-in to an existing account (self-host setup CLI). A new
 * email gets a user with this password; an existing user joins the account.
 */
export async function createPasswordUser(data: DataAccess, accountId: string, email: string, password: string, role: Role = "owner") {
  const addr = email.trim().toLowerCase();
  let user = await data.db().selectFrom("users").select("id").where("email", "=", addr).executeTakeFirst();
  if (!user) {
    if (password.length < 10) throw new Error("password must be at least 10 characters");
    user = await data.db().insertInto("users").values({ id: newId("usr"), account_id: accountId, email: addr, password_hash: await hashPassword(password) }).returning("id").executeTakeFirstOrThrow();
  }
  await data.withAccount(accountId, (s) => s.db.insertInto("memberships").values({ account_id: accountId, user_id: user.id, role })
    .onConflict((oc) => oc.columns(["account_id", "user_id"]).doUpdateSet({ role })).execute());
}
