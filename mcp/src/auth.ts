// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// OAuth 2.1 for the remote MCP endpoint (MCP authorization spec, 2025-06-18):
// protected-resource and authorization-server metadata, dynamic client
// registration, authorization code + PKCE (S256), refresh tokens.
//
// Consent happens in the console, where people already sign in (ADR 0048):
//   1. /oauth/authorize checks the request, seals it (with a random nonce) and
//      sends the browser to <console>/connect#request=<sealed>.
//   2. The console reads what to show from /oauth/request (client name,
//      redirect host, verified or not, and the nonce's hash, the binding).
//   3. The person signs in if needed, picks sources and permissions and
//      allows; the API creates the app's agent and grants and returns a
//      single-use connect code bound to the binding.
//   4. The console posts {request, code} to /oauth/approve. This service
//      redeems the code at the API with the nonce only it can read, receives
//      the app's agent key, and redirects to the client with an OAuth code.
//      /oauth/deny sends the client `access_denied`.
// The browser never holds a Senseplane key. Client ids, requests, codes and
// tokens are AES-256-GCM sealed with MCP_TOKEN_SECRET, so the service keeps
// no state beyond the grant store. The key inside a token is checked by the
// API on every call, so disconnecting the app revokes its tokens (ADR 0023).
// Codes are single-use: a grant store remembers redeemed codes, and redeeming
// one twice revokes the tokens issued from it (ADR 0026).
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { memoryGrantStore, type OAuthGrantStore } from "./grant-store.js";

type Sealed = Record<string, unknown> & { k: "client" | "req" | "code" | "access" | "refresh"; exp?: number };
export const ACCESS_TTL_S = 3600;
/** How long a "this key is still valid" answer from the API is reused. */
export const KEY_CHECK_MS = 5_000;
export const REFRESH_TTL_S = 30 * 86400;
const CODE_TTL_S = 120;
/** How long someone has to sign in and decide on the consent page. */
export const REQUEST_TTL_S = 15 * 60;

export function sealer(secret: string) {
  const key = createHash("sha256").update(secret).digest();
  return {
    seal(v: Sealed): string {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([c.update(JSON.stringify(v)), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
    },
    open(token: string, kind: Sealed["k"]): Sealed | undefined {
      try {
        const raw = Buffer.from(token, "base64url");
        const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        const v = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString()) as Sealed;
        if (v.k !== kind || (v.exp && v.exp < Date.now() / 1000)) return undefined;
        return v;
      } catch {
        return undefined;
      }
    },
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const now = () => Math.floor(Date.now() / 1000);

/**
 * Redirect URIs a client may register (ADR 0039): https,
 * loopback http, or a private-use app scheme in reverse-DNS form
 * (`com.example.app:/callback`). Never javascript:, data:, file: or similar.
 */
export function allowedRedirectUri(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const scheme = url.protocol.slice(0, -1);
  return /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(scheme) && !/^(javascript|data|file|vbscript|blob|about)$/i.test(scheme);
}

/** The host an authorization code is sent to, as the consent page names it (an app scheme names itself). */
export function redirectHost(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || u.protocol;
  } catch {
    return "";
  }
}

/** What the API answers when the MCP service redeems a connect code. */
export type Redeemed = { api_key: string } | { error: string };

export function registerOAuth(app: FastifyInstance, o: {
  base: (req: FastifyRequest) => string; secret: string; verifyKey: (key: string) => Promise<boolean>; grants?: OAuthGrantStore;
  /** The console's base URL: the consent page is `<console>/connect`. */
  consoleUrl: string;
  /** Redeems a connect code at the API (POST /auth/connect/redeem) for the approved app's key. */
  redeem: (body: { code: string; nonce: string; client_name: string; redirect_host: string }) => Promise<Redeemed>;
  /** Redirect hosts shown as verified on the consent page (e.g. claude.ai). */
  trustedRedirectHosts?: string[];
}) {
  const box = sealer(o.secret);
  const grants = o.grants ?? memoryGrantStore();
  const consoleUrl = o.consoleUrl.replace(/\/+$/, "");
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_r, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  app.get("/.well-known/oauth-protected-resource", async (req) => ({
    resource: `${o.base(req)}/mcp`, authorization_servers: [o.base(req)], bearer_methods_supported: ["header"], scopes_supported: ["senseplane"],
  }));
  app.get("/.well-known/oauth-protected-resource/mcp", async (req) => ({
    resource: `${o.base(req)}/mcp`, authorization_servers: [o.base(req)], bearer_methods_supported: ["header"], scopes_supported: ["senseplane"],
  }));
  app.get("/.well-known/oauth-authorization-server", async (req) => {
    const b = o.base(req);
    return {
      issuer: b, authorization_endpoint: `${b}/oauth/authorize`, token_endpoint: `${b}/oauth/token`, registration_endpoint: `${b}/oauth/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["senseplane"],
    };
  });

  app.post<{ Body: { redirect_uris?: string[]; client_name?: string } }>("/oauth/register", async (req, reply) => {
    const uris = req.body?.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2000 && allowedRedirectUri(u))) {
      return reply.code(400).send({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https, loopback http, or a reverse-DNS app scheme" });
    }
    const client_name = String(req.body.client_name ?? "MCP client").trim().slice(0, 100) || "MCP client";
    const client_id = box.seal({ k: "client", uris, name: client_name });
    return reply.code(201).send({ client_id, client_id_issued_at: now(), redirect_uris: uris, client_name, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  });

  type AuthQuery = { client_id: string; redirect_uri: string; code_challenge: string; code_challenge_method?: string; state?: string; response_type?: string; resource?: string; scope?: string };
  const checkAuthRequest = (q: AuthQuery) => {
    const client = q.client_id ? box.open(q.client_id, "client") : undefined;
    if (!client) return "unknown client_id (register first)";
    if (!(client.uris as string[]).includes(q.redirect_uri)) return "redirect_uri is not registered for this client";
    if (q.response_type !== "code") return "response_type must be code";
    if (!q.code_challenge || (q.code_challenge_method ?? "S256") !== "S256") return "PKCE with S256 is required";
    return { name: String(client.name) };
  };
  const verified = (host: string) => (o.trustedRedirectHosts ?? []).includes(host);
  const sha = (s: string) => createHash("sha256").update(s).digest("base64url");
  const openRequest = (r: unknown) => (typeof r === "string" && r ? box.open(r, "req") : undefined);

  /** A small page for dead ends (expired or failed requests), in the console's colours. */
  const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Senseplane</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0A0B;color:#EDEDEF;font:15px/1.5 "Geist",ui-sans-serif,system-ui,sans-serif;padding:24px;box-sizing:border-box}main{max-width:380px;width:100%;display:flex;flex-direction:column;gap:12px}h1{font-size:22px;font-weight:600;margin:0}p{margin:0;color:#9A9AA2}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(body)}</p></main></body></html>`;
  const deadEnd = (reply: FastifyReply, status: number, title: string, body: string) =>
    reply.code(status).type("text/html").header("x-frame-options", "DENY").header("content-security-policy", "frame-ancestors 'none'").send(page(title, body));

  // 1. Seal the checked request and send the person to the console's consent page.
  // The fragment keeps the request out of the console's server logs.
  app.get<{ Querystring: AuthQuery }>("/oauth/authorize", async (req, reply) => {
    const ok = checkAuthRequest(req.query);
    if (typeof ok === "string") return reply.code(400).type("text/plain").send(ok);
    const q = req.query;
    const request = box.seal({
      k: "req", cid: q.client_id, uri: q.redirect_uri, pkce: q.code_challenge, state: q.state ?? "", name: ok.name,
      nonce: randomBytes(24).toString("base64url"), exp: now() + REQUEST_TTL_S,
    });
    return reply.redirect(`${consoleUrl}/connect#${new URLSearchParams({ request })}`, 302);
  });

  // 2. What the consent page shows. Readable by any origin: it describes a request to whoever holds it.
  app.get<{ Querystring: { request?: string } }>("/oauth/request", async (req, reply) => {
    reply.header("access-control-allow-origin", "*").header("cache-control", "no-store");
    const r = openRequest(req.query.request);
    if (!r) return reply.code(410).send({ error: "invalid_request", error_description: "This connection request expired. Start again from your app." });
    const host = redirectHost(String(r.uri));
    return { client_name: String(r.name), redirect_host: host, verified: verified(host), binding: sha(String(r.nonce)), expires_at: new Date(Number(r.exp) * 1000).toISOString() };
  });

  const back = (r: Sealed, params: Record<string, string>) => {
    const to = new URL(String(r.uri));
    for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
    if (r.state) to.searchParams.set("state", String(r.state));
    return to.toString();
  };

  // 3. The person allowed it in the console: redeem the connect code for the app's key, then hand the client its code.
  app.post<{ Body: { request?: string; code?: string } }>("/oauth/approve", async (req, reply) => {
    const r = openRequest(req.body?.request);
    if (!r) return deadEnd(reply, 410, "This request expired", "Go back to your app and connect again.");
    const got = await o.redeem({ code: String(req.body?.code ?? ""), nonce: String(r.nonce), client_name: String(r.name), redirect_host: redirectHost(String(r.uri)) })
      .catch((): Redeemed => ({ error: "Senseplane didn't answer." }));
    if (!("api_key" in got)) return deadEnd(reply, 400, "Couldn't finish connecting", `${got.error} Go back to your app and connect again.`);
    const code = box.seal({ k: "code", jti: randomBytes(16).toString("base64url"), key: got.api_key, cid: r.cid, uri: r.uri, pkce: r.pkce, exp: now() + CODE_TTL_S });
    return reply.redirect(back(r, { code }), 302);
  });

  // Cancel: tell the client the person said no.
  app.post<{ Body: { request?: string } }>("/oauth/deny", async (req, reply) => {
    const r = openRequest(req.body?.request);
    if (!r) return deadEnd(reply, 410, "This request expired", "Nothing was connected. You can close this tab.");
    return reply.redirect(back(r, { error: "access_denied", error_description: "The person declined" }), 302);
  });

  // `gj` ties every token to the code it came from, so a replayed code can revoke them all.
  const tokens = (key: string, cid: string, gj: string) => ({
    access_token: box.seal({ k: "access", key, cid, gj, exp: now() + ACCESS_TTL_S }), token_type: "Bearer", expires_in: ACCESS_TTL_S,
    refresh_token: box.seal({ k: "refresh", key, cid, gj, exp: now() + REFRESH_TTL_S }), scope: "senseplane",
  });
  app.post<{ Body: Record<string, string> }>("/oauth/token", async (req, reply) => {
    const b = req.body ?? {};
    reply.header("cache-control", "no-store");
    const bad = (error: string, d: string) => reply.code(400).send({ error, error_description: d });
    if (b.grant_type === "authorization_code") {
      const c = box.open(b.code ?? "", "code");
      if (!c || c.cid !== b.client_id || c.uri !== b.redirect_uri) return bad("invalid_grant", "code is invalid, expired, or for another client");
      const challenge = createHash("sha256").update(b.code_verifier ?? "").digest("base64url");
      if (challenge.length !== String(c.pkce).length || !timingSafeEqual(Buffer.from(challenge), Buffer.from(String(c.pkce)))) return bad("invalid_grant", "PKCE verification failed");
      const jti = String(c.jti ?? "");
      if (!jti || !(await grants.consume(jti, CODE_TTL_S + 60))) {
        if (jti) await grants.revoke(jti, REFRESH_TTL_S);
        return bad("invalid_grant", "code was already used; tokens issued from it are revoked");
      }
      return tokens(String(c.key), String(c.cid), jti);
    }
    if (b.grant_type === "refresh_token") {
      const r = box.open(b.refresh_token ?? "", "refresh");
      if (!r || (b.client_id && r.cid !== b.client_id) || !r.gj || (await grants.isRevoked(String(r.gj)))) return bad("invalid_grant", "refresh token is invalid, expired or revoked");
      if (!(await o.verifyKey(String(r.key)))) return bad("invalid_grant", "this app was disconnected in Senseplane");
      return tokens(String(r.key), String(r.cid), String(r.gj));
    }
    return bad("unsupported_grant_type", "use authorization_code or refresh_token");
  });

  // A disconnected app's key is revoked in the API; re-check it at most every KEY_CHECK_MS so
  // its access token stops working within seconds instead of at expiry.
  const checked = new Map<string, { ok: boolean; at: number }>();
  const keyStillValid = async (key: string) => {
    const hit = checked.get(key);
    if (hit && Date.now() - hit.at < KEY_CHECK_MS) return hit.ok;
    const ok = await o.verifyKey(key).catch(() => hit?.ok ?? false);
    if (checked.size > 10_000) checked.clear();
    checked.set(key, { ok, at: Date.now() });
    return ok;
  };

  /** The Senseplane API key for a request: an OAuth access token, or an API key sent directly. */
  return async function credentials(req: FastifyRequest): Promise<string | undefined> {
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
    if (!token) return undefined;
    if (token.startsWith("sk_")) return token;
    const a = box.open(token, "access");
    if (!a || !a.gj || (await grants.isRevoked(String(a.gj)))) return undefined;
    if (!(await keyStillValid(String(a.key)))) return undefined;
    return a.key as string;
  };
}

export function unauthorized(reply: FastifyReply, base: string) {
  return reply.code(401)
    .header("www-authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
    .send({ jsonrpc: "2.0", error: { code: -32001, message: "authentication required" }, id: null });
}
