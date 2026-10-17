// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Remote MCP: Streamable HTTP at /mcp (stateless: one server per request),
// authorized by OAuth 2.1 (auth.ts) or a Senseplane API key in the header.
import { createHash, randomBytes } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { Counter, Registry, collectDefaultMetrics } from "prom-client";
import { Senseplane } from "senseplane";
import { type Redeemed, registerOAuth, unauthorized } from "./auth.js";
import type { OAuthGrantStore } from "./grant-store.js";
import { createMcpServer } from "./handlers.js";
import { watchInbox } from "./inbox.js";
import { logMixin } from "@senseplane/telemetry";
import { tools } from "./tools.js";

export interface McpServiceOptions {
  logger?: FastifyServerOptions["logger"];
  /** Senseplane API base, e.g. http://localhost:8080/v1 */
  apiUrl?: string;
  /** This service's public URL (OAuth issuer and resource); default from the Host header. */
  publicUrl?: string;
  /** Seals OAuth clients, codes and tokens. Required in production. */
  tokenSecret?: string;
  fetch?: typeof fetch;
  /** Where redeemed OAuth codes are recorded. Shared (Valkey) when several instances run; required in production. */
  grants?: OAuthGrantStore;
  /** The console's base URL, where people approve a connection (ADR 0048). Default MCP_CONSOLE_URL, then CONSOLE_URL. */
  consoleUrl?: string;
}

export function createMcpService(options: McpServiceOptions = {}): FastifyInstance {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const calls = new Counter({ name: "senseplane_mcp_requests_total", help: "MCP HTTP requests by status", labelNames: ["status"] as const, registers: [registry] });
  // Trust only listed proxies or a fixed hop count, never every X-Forwarded-For entry (ADR 0040).
  const proxies = (process.env.TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const hops = Number(process.env.TRUST_PROXY);
  const trustProxy = proxies.length ? proxies : Number.isInteger(hops) && hops > 0 ? (_a: string, hop: number) => hop < hops : false;
  const app = Fastify({ logger: options.logger ?? { level: process.env.LOG_LEVEL ?? "info", mixin: logMixin }, trustProxy });
  const apiUrl = (options.apiUrl ?? process.env.SENSEPLANE_API_URL ?? "http://localhost:8080/v1").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  const base = (req: FastifyRequest) => (options.publicUrl ?? process.env.MCP_PUBLIC_URL ?? `${req.protocol}://${req.host}`).replace(/\/$/, "");
  const secret = options.tokenSecret ?? process.env.MCP_TOKEN_SECRET;
  const production = process.env.NODE_ENV === "production" || process.env.SENSEPLANE_MODE === "production";
  if (production && (!secret || secret === "dev-only-change-me")) throw new Error("MCP_TOKEN_SECRET must be set to a real secret in production");
  if (production && !options.grants) throw new Error("set VALKEY_URL in production so redeemed OAuth codes are shared across instances");
  // The OAuth issuer must not follow the Host header in production.
  if (production && !(options.publicUrl ?? process.env.MCP_PUBLIC_URL)) throw new Error("MCP_PUBLIC_URL is required in production");
  if (production && /\/\/[^@/]*:dev-[^@]*@/.test(process.env.VALKEY_URL ?? "")) throw new Error("the Valkey password is a development default");
  // Consent happens in the console (ADR 0048); CONSOLE_URL may list several origins, the first is used.
  const consoleUrl = (options.consoleUrl ?? process.env.MCP_CONSOLE_URL ?? process.env.CONSOLE_URL?.split(",")[0])?.trim();
  if (production && !consoleUrl) throw new Error("MCP_CONSOLE_URL (the console's public URL) is required in production");
  const client = (apiKey: string) => new Senseplane({ apiKey, baseUrl: apiUrl, fetch: doFetch });

  const verifyKey = async (key: string) => (await doFetch(`${apiUrl}/sources?limit=1`, { headers: { authorization: `Bearer ${key}` } })).ok;
  // The approved app's agent key, from the connect code the console posted (ADR 0048). Only
  // agent keys come out of consent.
  const authUrl = apiUrl.replace(/\/v1$/, "/auth");
  const redeem = async (body: { code: string; nonce: string; client_name: string; redirect_host: string }): Promise<Redeemed> => {
    const r = await doFetch(`${authUrl}/connect/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = (await r.json().catch(() => ({}))) as { api_key?: string; error?: { message?: string; details?: { reason?: string } } };
    if (r.ok && out.api_key) return { api_key: out.api_key };
    const reason = out.error?.details?.reason;
    return { error: reason === "code_invalid" ? "The approval expired or was already used." : r.status === 404 ? "This app was disconnected." : "The approval didn't match this request." };
  };
  const credentials = registerOAuth(app, {
    base, secret: secret ?? randomBytes(32).toString("hex"), // dev: tokens die with the process
    grants: options.grants, consoleUrl: consoleUrl || "http://localhost:5173",
    verifyKey, redeem,
    trustedRedirectHosts: (process.env.MCP_TRUSTED_REDIRECT_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
  });

  app.get("/healthz", async () => ({ status: "ok", tools: tools.length }));
  // /metrics is for the operator (ADR 0040): a bearer METRICS_TOKEN when set; never public in production.
  app.get("/metrics", async (req, reply) => {
    const token = process.env.METRICS_TOKEN;
    if (token ? req.headers.authorization !== `Bearer ${token}` : production) return reply.code(404).send({ error: "not found" });
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  // Rate limits (ADR 0040): per IP for OAuth endpoints, per bearer for /mcp. Fixed one-minute windows, per process.
  const perMinute = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600);
  const oauthPerMinute = Number(process.env.RATE_LIMIT_OAUTH_PER_MINUTE ?? 60);
  const windows = new Map<string, { start: number; count: number }>();
  app.addHook("onRequest", async (req, reply) => {
    const oauth = req.url.startsWith("/oauth/");
    if (!oauth && !req.url.startsWith("/mcp")) return;
    const limit = oauth ? oauthPerMinute : perMinute;
    if (limit <= 0) return;
    const h = req.headers.authorization ?? "";
    const bucket = oauth || !h ? `ip:${req.ip}` : `k:${createHash("sha256").update(h).digest("hex").slice(0, 24)}`;
    const now = Date.now();
    if (windows.size > 50_000) for (const [k, w] of windows) if (now - w.start >= 60_000) windows.delete(k);
    let w = windows.get(bucket);
    if (!w || now - w.start >= 60_000) windows.set(bucket, (w = { start: now, count: 0 }));
    if (++w.count > limit) {
      return reply.code(429).header("retry-after", String(Math.ceil((w.start + 60_000 - now) / 1000))).send({ error: "rate_limited", error_description: "too many requests" });
    }
  });

  const handle = async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
    const key = await credentials(req);
    if (!key) {
      calls.inc({ status: "401" });
      return unauthorized(reply, base(req));
    }
    const server = createMcpServer(client(key), doFetch);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    calls.inc({ status: String(reply.raw.statusCode) });
  };
  app.post("/mcp", handle);
  // The server-initiated stream (GET, text/event-stream) carries inbox notifications for the
  // caller's agent while it stays open (ADR 0043, inbox.ts). Still stateless: no sessions.
  app.get("/mcp", async (req, reply) => {
    if (!String(req.headers.accept ?? "").includes("text/event-stream")) {
      return reply.code(405).header("allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "method not allowed" }, id: null });
    }
    const key = await credentials(req);
    if (!key) {
      calls.inc({ status: "401" });
      return unauthorized(reply, base(req));
    }
    const c = client(key);
    const server = createMcpServer(c, doFetch);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    // handleRequest holds until the stream ends; notifications sent before it opens are dropped.
    const stop = watchInbox(server, c, { always: true, log: (msg, err) => app.log.warn({ err }, msg) });
    reply.raw.on("close", () => {
      stop();
      void transport.close();
      void server.close();
    });
    calls.inc({ status: "stream" });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw);
  });
  app.delete("/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send({ jsonrpc: "2.0", error: { code: -32000, message: "method not allowed" }, id: null }));
  return app;
}
