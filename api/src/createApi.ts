// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Kysely } from "kysely";
import { Counter, Registry, collectDefaultMetrics } from "prom-client";
import { logMixin } from "@senseplane/telemetry";
import { DataAccess } from "./data/access.js";
import { createDb } from "./data/db.js";
import type { Database } from "./data/schema.js";
import { ApiError, errorBody } from "./errors.js";
import type { ApiBus } from "./indexer.js";
import { type ValkeyBus, startBus } from "./valkey.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { expireWatches, registerWatchRoutes } from "./routes/watches.js";
import { registerInboxRoutes } from "./routes/inbox.js";
import { checkRoute } from "./access.js";
import { checkRole } from "./roles.js";
import { purgeDeletedAccounts } from "./purge.js";
import { registerTrustRoutes } from "./routes/trust.js";
import { registerAppRoutes } from "./routes/apps.js";
import { enforceLimits, isIngestMeter, overLimits, registerUsageRoutes, sampleStorage } from "./routes/usage.js";
import { kvValue } from "./routes/watches.js";
import { demoConfig, registerDemoRoutes, sweepDemos } from "./routes/demo.js";
import { registerSourceConfigRoutes } from "./routes/source-config.js";
import { startClipWorker, startWebhookWorker } from "./workers.js";
import type { Source } from "./data/access.js";
import { createIngestSigner } from "./ingest.js";
import { type ControlClient, httpControlClient } from "./media-client.js";
import { type MediaControl, type MediaOptions, createMediaDriver } from "./media-driver.js";
import { registerMediaCallbacks } from "./routes/media-callbacks.js";
import { MaskCache } from "./frames.js";
import type { ApiModule, AuditLog, ModuleContext, Quota, UsageRecord } from "./module.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerLiveRoutes, sweepLiveSessions } from "./routes/live.js";
import { markSilentBridges, registerBridgeRoutes } from "./routes/bridges.js";
import { closeStaleActivities } from "./activity.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerPlaybackRoutes } from "./routes/playback.js";
import { createKeyRefSealer, createPlaybackSigner, newPlaybackSecret } from "./playback.js";
import { createMediaGuard, mediaClaims } from "./media-access.js";
import { metricsAllowed, registerRateLimits, trustProxyFromEnv } from "./rate-limit.js";
import { hashApiKey } from "./data/access.js";
import type { FastifyRequest } from "fastify";
import { type ObjectStorage, type StorageConfig, createObjectStorage } from "./storage.js";
import { startSweeper } from "./sweeper.js";
import { isProduction } from "./ingest.js";
import { createSecretBox, newSecretsKey } from "./secret-box.js";
import { expireIdempotencyKeys, registerIdempotency } from "./idempotency.js";
import { registerTeamRoutes } from "./routes/team.js";
import { type AuthConfig, authConfig, httpOAuthClient, type OAuthClient, registerAuthRoutes } from "./routes/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    accountId?: string;
  }
}

export interface CreateApiOptions {
  /** Postgres connection string for the runtime role, or an existing Kysely instance. */
  database: string | Kysely<Database>;
  /** Optional extensions (administration, abuse tooling, …). */
  modules?: ApiModule[];
  /** When set, a second listener serves module internal routes (keep it off the public network). */
  internalPort?: number;
  /** Fastify logger option; defaults to JSON logs at info. */
  logger?: FastifyServerOptions["logger"];
  defaultQuota?: Quota;
  /**
   * The media plane (spec/media, ADR 0049): its control API (MEDIA_CONTROL_URL, or a client in tests),
   * its public base for WHIP URLs (MEDIA_PUBLIC_URL), and where it calls back (API_CALLBACK_URL,
   * default apiPublicUrl): a laptop can expose only that through a tunnel.
   */
  media?: { control: string | ControlClient; publicUrl?: string; callbackUrl?: string; options?: MediaOptions };
  /** MEDIA_SIGNING_KEY ("kid:base64pem"); outside production a key is generated when unset. */
  mediaSigningKey?: string;
  /** MEDIA_ISSUER, the media plane's instance id (default senseplane). */
  mediaIssuer?: string;
  /** Capture page URL, e.g. https://console.example.com/capture.html */
  captureUrl?: string;
  /** The bridge image named in the `docker run` command for RTSP cameras (default `ghcr.io/senseplane-ai/bridge:0.1`, the release line, or BRIDGE_IMAGE). ADR 0045. */
  bridgeImage?: string;
  /** Valkey between the API, its brains and MCP (ADR 0051); omit to run without a brain. */
  valkeyUrl?: string;
  /** Browser origins allowed to call the API (the console). */
  corsOrigins?: string[];
  /** Capture link (ticket) lifetime, default 24 h. */
  ticketTtlSeconds?: number;
  /** Media join token lifetime, default 600 s (protocol maximum 900 s). */
  joinTtlSeconds?: number;
  /** Public API base URL put in capture links; defaults to each request's origin. */
  apiPublicUrl?: string;
  /** Object storage for playback, clips and retention; omit to disable those routes. */
  storage?: StorageConfig | ObjectStorage;
  /** Console sign-in settings; default from env (AUTH_*, CONSOLE_URL). ADR 0031. */
  auth?: Partial<AuthConfig>;
  /** Invites an account may create per hour (default 30). ADR 0044. */
  invitesPerHour?: number;
  /** OAuth HTTP client for Google/GitHub sign-in (tests inject a fake). */
  oauthClient?: OAuthClient;
  /** Key for secrets encrypted at rest (SECRETS_ENCRYPTION_KEY); generated and stored outside production if unset. */
  secretsEncryptionKey?: string;
  /** HMAC secret for playback URLs; generated and stored outside production if unset. */
  playbackSecret?: string;
  /** Playback URL lifetime (default 900 s). */
  playbackTtlSeconds?: number;
  /** Retention sweep interval; 0 disables the background sweeper (default 600 s). */
  sweepIntervalSeconds?: number;
  /** Background workers (webhooks, event clips); default on. Tests may turn them off. */
  workers?: boolean;
  /** A bus to use instead of connecting to valkeyUrl (tests). */
  bus?: ApiBus;
  /** Live view (ADR 0042): viewers idle this long are closed (default LIVE_IDLE_TIMEOUT_SECONDS or 600). */
  liveIdleTimeoutSeconds?: number;
  /** Live view join token lifetime (default 60 s). */
  liveTokenTtlSeconds?: number;
}

export interface SenseplaneApi {
  public: FastifyInstance;
  internal?: FastifyInstance;
  data: DataAccess;
  /** Records usage and forwards it to every module's onUsage hook. */
  recordUsage(record: UsageRecord): Promise<void>;
  quotaFor(accountId: string): Promise<Quota>;
  listen(options: { port: number; host?: string }): Promise<void>;
  close(): Promise<void>;
}

/** The instance's default quota from its environment; a quota provider module can set one per account. */
export function defaultQuota(env: NodeJS.ProcessEnv = process.env): Quota {
  const num = (v: string | undefined) => (v ? Number(v) : null);
  // AI checks (model calls) per account per UTC day; over it, model-backed routes answer
  // 429 allowance_exhausted and watches pause until the next day. Unset: no cap.
  const aiChecks = num(env.QUOTA_MAX_AI_CHECKS_PER_DAY);
  return {
    // Unlimited unless set (ADR 0025).
    maxSources: num(env.QUOTA_MAX_SOURCES),
    maxActiveSources: num(env.QUOTA_MAX_ACTIVE_SOURCES),
    usageLimits: aiChecks ? [{ meter: "ai_checks", period: "day", limit: aiChecks, enforcement: "hard" }] : undefined,
    maxRetentionDays: num(env.RAW_RETENTION_MAX_DAYS),
    maxResolution: env.QUOTA_MAX_RESOLUTION === "1080p" ? "1080p" : "720p",
    // Live view is on and unlimited unless a deployment says otherwise (ADR 0042).
    liveView: env.QUOTA_LIVE_VIEW !== "0",
    maxLiveViewers: num(env.QUOTA_MAX_LIVE_VIEWERS),
  };
}
const DEFAULT_QUOTA = defaultQuota();

export async function createApi(options: CreateApiOptions): Promise<SenseplaneApi> {
  const modules = options.modules ?? [];
  const ownsDb = typeof options.database === "string";
  const db = typeof options.database === "string" ? createDb(options.database) : options.database;
  const data = new DataAccess(db);
  // Media tokens live in URL paths; logs keep only a placeholder.
  const redactUrl = (url: string) => url.replace(/^\/(playback|media)\/[^/]+/, "/$1/<token>");
  const logger = options.logger ?? {
    level: process.env.LOG_LEVEL ?? "info",
    // trace_id/span_id on every log line inside a span (observability ADR).
    mixin: logMixin,
    serializers: {
      req: (r: { method: string; url: string; id?: string }) => ({ method: r.method, url: redactUrl(r.url), id: r.id }),
    },
  };

  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const requests = new Counter({
    name: "senseplane_api_requests_total",
    help: "HTTP requests by route and status",
    labelNames: ["listener", "route", "status"] as const,
    registers: [registry],
  });

  const audit: AuditLog = {
    async write(entry) {
      if (entry.accountId) {
        await data.withAccount(entry.accountId, (s) => s.db.insertInto("audit_log").values({
          account_id: entry.accountId!, actor: entry.actor, action: entry.action, target: entry.target,
          status: entry.status ?? null, details: entry.details ? JSON.stringify(entry.details) : null,
        }).execute());
      }
      for (const m of modules) await m.onAudit?.(entry);
    },
  };

  const ctx: ModuleContext = {
    data,
    audit,
    auth: {
      // The open-source API defines no operator principals, so role checks fail closed.
      requireRole: () => async (req, reply) => {
        await reply.code(401).send(errorBody("unauthorized", "authentication required", String(req.id)));
      },
    },
  };

  async function quotaFor(accountId: string): Promise<Quota> {
    for (const m of modules) {
      const q = await m.quotaFor?.(accountId);
      if (q) return q;
    }
    return options.defaultQuota ?? DEFAULT_QUOTA;
  }

  function build(listener: "public" | "internal"): FastifyInstance {
    const instance = Fastify({
      logger, genReqId: () => randomUUID(), requestIdHeader: "x-request-id", maxParamLength: 2048,
      // Behind a reverse proxy: list it in TRUSTED_PROXIES (or TRUST_PROXY=<hops>) so per-IP limits see client IPs (ADR 0040).
      trustProxy: trustProxyFromEnv(),
    });
    if (listener === "public") registerRateLimits(instance);
    instance.addHook("onSend", async (req, reply) => {
      reply.header("x-request-id", req.id);
    });
    instance.addHook("onResponse", async (req, reply) => {
      requests.inc({ listener, route: req.routeOptions.url ?? "unmatched", status: String(reply.statusCode) });
    });
    instance.setErrorHandler((err, req, reply) => {
      if (err instanceof ApiError) return reply.code(err.status).send(errorBody(err.code, err.message, String(req.id), err.details));
      if ((err as { validation?: unknown }).validation) {
        return reply.code(400).send(errorBody("validation_failed", (err as Error).message, String(req.id)));
      }
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) {
        // Fastify's own client errors (bad JSON, empty body with a JSON content-type, too large…).
        return reply.code(status).send(errorBody(status === 429 ? "rate_limited" : "validation_failed", (err as Error).message, String(req.id)));
      }
      req.log.error({ err }, "unhandled error");
      return reply.code(500).send({ error: { code: "internal", message: "internal error", request_id: String(req.id) } });
    });
    instance.setNotFoundHandler((req, reply) => {
      reply.code(404).send(errorBody("not_found", "route not found", String(req.id)));
    });
    instance.get("/healthz", async (_req, reply) => {
      try {
        await data.ping();
        return { status: "ok" };
      } catch {
        return reply.code(503).send({ status: "unavailable" });
      }
    });
    return instance;
  }

  const app = build("public");
  // The console's origins everywhere; the website's origins only for the demo and capture-join (ADR 0021).
  const demo = demoConfig();
  const consoleOrigins = options.corsOrigins ?? [];
  await app.register(cors, () => (req: { url?: string }, cb: (e: Error | null, o: object) => void) => {
    const site = req.url?.startsWith("/v1/demo/") || req.url === "/v1/capture/join" || req.url?.startsWith("/media/") || req.url?.startsWith("/playback/");
    const allowed = site ? [...consoleOrigins, ...demo.origins] : consoleOrigins;
    cb(null, { origin: allowed.length ? allowed : false, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"], maxAge: 600 });
  });
  app.get("/metrics", async (req, reply) => {
    if (!metricsAllowed(req)) throw new ApiError(404, "not_found", "route not found");
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  const signer = await createIngestSigner(data, options.mediaSigningKey ?? process.env.MEDIA_SIGNING_KEY ?? process.env.INGEST_SIGNING_KEY, options.mediaIssuer ?? process.env.MEDIA_ISSUER ?? "senseplane");
  app.get("/.well-known/senseplane-ingest-jwks.json", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return signer.jwks;
  });

  // Every /v1 route needs an API key (Authorization: Bearer sk_...).
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/v1/") || req.method === "OPTIONS" || req.url === "/v1/capture/join" || req.url.startsWith("/v1/demo/")) return;
    if (req.url.startsWith("/v1/bridge/")) return; // bridge token, checked by the bridge routes (ADR 0045)
    const header = req.headers.authorization ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (key.startsWith("sit_")) {
      // Sensor integration token (Home Assistant): readings for one source only, see checkRoute.
      const p = await data.authenticateIntegrationToken(key);
      if (!p) throw new ApiError(401, "unauthorized", "unknown or revoked integration token");
      req.accountId = p.accountId;
      req.access = { actor: `integration:${key.slice(0, 8)}`, integrationSource: p.sourceId, keyHash: hashApiKey(key) };
      return;
    }
    const principal = key ? await data.authenticate(key) : undefined;
    if (!principal) throw new ApiError(401, "unauthorized", "a valid API key is required");
    req.accountId = principal.accountId;
    if (principal.agentId) {
      // Read on every request, so a revoked grant stops working on the next one (ADR 0024).
      const grants = await data.withAccount(principal.accountId, (s) =>
        s.db.selectFrom("grants").select(["source_ids", "senses", "window_from", "window_to", "abilities"]).where("agent_id", "=", principal.agentId!).execute());
      req.access = { actor: `agent:${principal.agentId}`, agentId: principal.agentId, grants, keyHash: hashApiKey(key) };
    } else if (principal.userId && principal.role) {
      req.access = { actor: `user:${principal.userId}`, keyHash: hashApiKey(key), userId: principal.userId, role: principal.role };
    } else {
      req.access = { actor: `owner:${key.slice(0, 7)}`, keyHash: hashApiKey(key) };
    }
  });
  // Usage limits from the quota provider (none by default, ADR 0025).
  const over = async (accountId: string, which: (m: string) => boolean) => {
    const limits = (await quotaFor(accountId)).usageLimits?.filter((l) => which(l.meter));
    return limits?.length ? (await overLimits(data, accountId, limits)).some((h) => h.hard) : false;
  };
  // Workspace roles for console sessions (ADR 0044), before body validation so a refused call learns nothing more.
  app.addHook("preValidation", async (req) => {
    if (req.access) checkRole(req);
  });
  app.addHook("preHandler", async (req) => {
    if (!req.access) return;
    checkRoute(req);
    const route = `${req.method} ${req.routeOptions.url}`;
    if ((route === "POST /v1/sources/:id/ask" || route === "POST /v1/watches" || route === "POST /v1/watches/test" || route === "POST /v1/conversations/:id/messages") && (await over(req.accountId!, (m) => m === "ai_checks"))) {
      throw new ApiError(429, "allowance_exhausted", "This account has used its AI checks for now.");
    }
  });
  registerIdempotency(app, data);
  const auth = { ...authConfig(), ...options.auth };
  registerAuthRoutes(app, {
    data, modules, config: auth, oauth: options.oauthClient ?? httpOAuthClient(), audit,
    publicBase: (req) => options.apiPublicUrl ?? `${req.protocol}://${req.host}`,
  });
  // Members, invites and workspace switching (ADR 0044).
  registerTeamRoutes(app, {
    data, audit, sessionDays: auth.sessionDays,
    config: { consoleUrl: auth.consoleUrls[0] ?? "http://localhost:5173", inviteDays: auth.inviteDays ?? 7, invitesPerHour: options.invitesPerHour ?? 30 },
  });
  // Audit: every authenticated /v1 request (ADR 0024).
  app.addHook("onResponse", async (req, reply) => {
    if (!req.access || !req.accountId) return;
    const entry = {
      accountId: req.accountId, actor: req.access.actor, action: `${req.method} ${req.routeOptions.url ?? req.url.split("?")[0]}`,
      target: (req.params as { id?: string } | undefined)?.id ?? "", status: reply.statusCode,
    };
    await audit.write(entry).catch((err) => app.log.warn({ err }, "audit write failed"));
  });

  const maxRetentionDays = async (accountId: string) => (await quotaFor(accountId)).maxRetentionDays;
  const storage = options.storage ? ("deleteMany" in options.storage ? options.storage : createObjectStorage(options.storage)) : undefined;
  let bus: ApiBus | undefined = options.bus;
  if (!bus && options.valkeyUrl) bus = await startBus(options.valkeyUrl, data, storage, app.log);
  const valkeyBus = bus && "publishMedia" in bus ? (bus as ValkeyBus) : undefined;
  const masks = new MaskCache(data);
  valkeyBus?.onSourceChanged((key) => masks.invalidate(key));
  const publishConfig = async (accountId: string, src: Source) => {
    masks.invalidate(`${accountId}.${src.id}`);
    await bus?.putSourceConfig(accountId, src.id, { zones: src.zones ?? [], privacy_masks: src.privacy_masks ?? [], record_audio: src.record_audio });
  };
  let secret = options.playbackSecret ?? process.env.PLAYBACK_SIGNING_SECRET;
  if (!secret) {
    if (isProduction()) throw new Error("PLAYBACK_SIGNING_SECRET is required in production");
    secret = (await data.secrets.get("playback_secret")) ?? (await data.secrets.putIfAbsent("playback_secret", newPlaybackSecret()));
  }
  const playbackSigner = createPlaybackSigner(secret);
  // Secrets the API must read back (webhook signing secrets) are encrypted at rest (ADR 0027).
  let secretsKey = options.secretsEncryptionKey ?? process.env.SECRETS_ENCRYPTION_KEY;
  if (!secretsKey) {
    if (isProduction()) throw new Error("SECRETS_ENCRYPTION_KEY is required in production");
    secretsKey = (await data.secrets.get("secrets_encryption_key")) ?? (await data.secrets.putIfAbsent("secrets_encryption_key", newSecretsKey()));
  }
  data.secretBox = createSecretBox(secretsKey);
  const reencrypted = await data.encryptLegacyWebhookSecrets();
  if (reencrypted) app.log.info({ count: reencrypted }, "encrypted webhook secrets stored before encryption at rest");
  const keyRefs = createKeyRefSealer(secret);
  const mediaGuard = createMediaGuard(data, keyRefs);
  const base = (req: { protocol: string; host: string }) => options.apiPublicUrl ?? `${req.protocol}://${req.host}`;
  // Media links in events carry the caller's claims (ADR 0036): no video grant, no media; no audio grant, no audio.
  const eventUrls = (req: { protocol: string; host: string; access?: FastifyRequest["access"] }) => ({
    signer: playbackSigner, base: base(req), ttlSeconds: options.playbackTtlSeconds ?? 900,
    claims: (sourceId: string, from: number, to: number) => mediaClaims(req, keyRefs, sourceId, from, to),
  });
  registerEventRoutes(app, { data, urls: eventUrls });
  const watchRoutes = registerWatchRoutes(app, { data, bus, storage, urls: eventUrls });
  registerConversationRoutes(app, { data, bus, storage, urls: eventUrls, checkHistory: watchRoutes.test });
  registerInboxRoutes(app, { data, urls: eventUrls });
  registerActivityRoutes(app, { data });
  // The media driver (ADR 0049): rooms, feeds and viewers through the control API, callbacks back here.
  const callbackBase = (options.media?.callbackUrl ?? options.apiPublicUrl ?? `http://localhost:${process.env.PORT ?? 8080}`).replace(/\/$/, "");
  const mediaDriver = options.media
    ? createMediaDriver({
        data, signer, log: app.log, callbackBase, ...(options.media.publicUrl ? { publicUrl: options.media.publicUrl } : {}),
        control: typeof options.media.control === "string" ? httpControlClient(options.media.control, () => signer.signControl()) : options.media.control,
        options: { maxViewersPerSource: Number(process.env.MEDIA_MAX_VIEWERS_PER_SOURCE ?? 50), ...(process.env.FEED_IDLE_STOP_SECONDS ? { feedIdleStopSeconds: Number(process.env.FEED_IDLE_STOP_SECONDS) } : {}), ...options.media.options },
      })
    : undefined;
  const mediaControl: MediaControl | undefined = mediaDriver;
  const maxResolutionFor = async (id: string) => (await quotaFor(id)).maxResolution ?? "720p";
  registerMediaCallbacks(app, {
    data, signer, storage, media: mediaControl, masks, log: app.log,
    ...(valkeyBus ? {
      publishMedia: (a: string, s: string, kind: "frame" | "audio", meta: Record<string, unknown>, buf: Buffer) => valkeyBus.publishMedia(a, s, kind, meta, buf),
      releaseCamera: (a: string, s: string) => valkeyBus.balancer.release(`${a}.${s}`),
    } : {}),
    // A feed that ended on the media plane while its camera is on is started again (a node restart, a failed host).
    onFeedEnded: async (accountId, sourceId, sessionId) => {
      const stopped = await data.withAccount(accountId, (s) => s.db.updateTable("media_feeds").set({ stopped_at: new Date(), stop_reason: "ended" })
        .where("source_id", "=", sourceId).where("session_id", "=", sessionId).where("stopped_at", "is", null).returning(["source_id"]).executeTakeFirst());
      const src = await data.withAccount(accountId, (s) => s.sources.get(sourceId));
      if (stopped && src?.status === "online" && mediaDriver) await mediaDriver.prepareCamera(accountId, src, { maxResolution: await maxResolutionFor(accountId) });
    },
  });
  const ipSalt = (await data.secrets.get("demo_ip_salt")) ?? (await data.secrets.putIfAbsent("demo_ip_salt", newPlaybackSecret()));
  registerTrustRoutes(app, { data, storage, urls: eventUrls });
  // Connected apps: MCP consent creates agents, the MCP service redeems their keys (ADR 0048).
  registerAppRoutes(app, { data, audit });
  registerUsageRoutes(app, { data, quotaFor });
  registerDemoRoutes(app, { data, bus, media: mediaControl, signer, storage, urls: eventUrls, apiPublicUrl: options.apiPublicUrl, config: demo, ipSalt });
  registerSourceConfigRoutes(app, { data, signer: playbackSigner, base, maxRetentionDays, publishConfig, keyRefs, storageCap: async (id) => (await quotaFor(id)).storageCapBytes });
  const storageCap = async (accountId: string) => (await quotaFor(accountId)).storageCapBytes;
  registerAccountRoutes(app, { data, maxRetentionDays, storageCap, quotaFor });
  const liveIdleTimeoutSeconds = options.liveIdleTimeoutSeconds ?? Number(process.env.LIVE_IDLE_TIMEOUT_SECONDS ?? 600);
  registerLiveRoutes(app, {
    data, signer, media: mediaControl, audit, quotaFor,
    idleTimeoutSeconds: liveIdleTimeoutSeconds,
    maxViewersPerSource: Number(process.env.MEDIA_MAX_VIEWERS_PER_SOURCE ?? 50),
    tokenTtlSeconds: options.liveTokenTtlSeconds ?? 60,
    overAllowance: async (accountId) => {
      const limits = (await quotaFor(accountId)).usageLimits?.filter((l) => l.meter === "live_view_minutes");
      const hit = limits?.length ? (await overLimits(data, accountId, limits)).find((h) => h.hard) : undefined;
      return hit ? { used: hit.used, limit: hit.limit } : undefined;
    },
  });
  const whipAuthorizeUrl = `${callbackBase}/internal/media/whip-authorize`;
  if (mediaDriver && options.captureUrl) {
    registerSourceRoutes(app, {
      data,
      signer,
      media: mediaDriver,
      captureUrl: options.captureUrl,
      apiPublicUrl: options.apiPublicUrl,
      ticketTtlSeconds: options.ticketTtlSeconds ?? 24 * 3600,
      joinTtlSeconds: options.joinTtlSeconds ?? 600,
      maxSources: async (id) => (await quotaFor(id)).maxSources,
      maxResolution: maxResolutionFor,
      maxActiveSources: async (id) => (await quotaFor(id)).maxActiveSources ?? null,
      ingestBlocked: (id) => over(id, isIngestMeter),
      maxRetentionDays,
      publishConfig,
      ...(mediaDriver.publicUrl ? { whipAuthorizeUrl } : {}),
      audit,
      bridgeImage: options.bridgeImage ?? process.env.BRIDGE_IMAGE,
    });
  }
  registerBridgeRoutes(app, {
    data, maxSources: async (id) => (await quotaFor(id)).maxSources, audit,
    ...(mediaDriver?.publicUrl ? { whip: { publicUrl: mediaDriver.publicUrl, authorizeUrl: whipAuthorizeUrl, signer } } : {}),
  });
  const stoppers: (() => void)[] = [];
  if (storage) {
    registerPlaybackRoutes(app, {
      data, storage, signer: playbackSigner, apiPublicUrl: options.apiPublicUrl, ttlSeconds: options.playbackTtlSeconds ?? 900,
      keyRefs, guard: mediaGuard,
      latestSnapshot: bus ? (a, s) => bus!.latestSnapshot(a, s) : undefined,
    });
    const interval = options.sweepIntervalSeconds ?? 600;
    if (interval > 0) stoppers.push(startSweeper(data, storage, app.log, interval, async (id) => (await quotaFor(id)).storageCapBytes));
    if (options.workers !== false) stoppers.push(startClipWorker(data, storage, app.log));
  }
  if (options.workers !== false) {
    let sampledHour = "";
    let overBefore = new Set<string>();
    const t = setInterval(() => {
      void sweepDemos({ data, bus, media: mediaControl, storage }, demo, app.log).catch((err) => app.log.error({ err }, "demo sweep failed"));
      void expireWatches(data, bus).catch((err) => app.log.error({ err }, "watch expiry failed"));
      void markSilentBridges(data, app.log).catch((err) => app.log.error({ err }, "bridge sweep failed"));
      void closeStaleActivities(data).catch((err) => app.log.error({ err }, "activity sweep failed"));
      void purgeDeletedAccounts({ data, bus, storage }, app.log).catch((err) => app.log.error({ err }, "account deletion failed"));
      // Live sessions the media plane stopped reporting (3 missed minute reports) are closed and metered.
      void mediaDriver?.sweepFeeds().catch((err) => app.log.error({ err }, "feed sweep failed"));
      const hour = new Date().toISOString().slice(0, 13);
      if (hour !== sampledHour) {
        sampledHour = hour;
        void sampleStorage(data).catch((err) => app.log.error({ err }, "storage sample failed"));
        void expireIdempotencyKeys(data).catch((err) => app.log.error({ err }, "idempotency expiry failed"));
      }
      void (async () => {
        const now = await enforceLimits({ data, bus, media: mediaControl, quotaFor, log: app.log,
          onUsageLimit: async (a, m, u, l) => { for (const mod of modules) await mod.onUsageLimit?.(a, m, u, l); } });
        // Back under every limit (a new day or month, or a raised limit): resume watches.
        for (const id of overBefore) {
          if (now.has(id)) continue;
          const rows = await data.withAccount(id, (s) => s.db.selectFrom("watches").selectAll().where("status", "=", "active").execute());
          for (const w of rows) await bus?.putWatch(id, w.id, kvValue(w));
        }
        overBefore = new Set(now.keys());
      })().catch((err) => app.log.error({ err }, "usage limits failed"));
    }, 30_000);
    t.unref();
    stoppers.push(() => clearInterval(t));
    // Live viewers: idle close, camera gone, metering (ADR 0042, 0049); its own cadence, as the idle timeout can be short.
    const lv = setInterval(() => {
      void sweepLiveSessions(data, { idleTimeoutSeconds: liveIdleTimeoutSeconds, media: mediaControl, log: app.log }).catch((err) => app.log.error({ err }, "live session sweep failed"));
    }, Number(process.env.LIVE_SWEEP_SECONDS ?? 10) * 1000);
    lv.unref();
    stoppers.push(() => clearInterval(lv));
    // Deliveries are built outside a request, so links use the configured public URL.
    const workerBase = options.apiPublicUrl ?? `http://localhost:${process.env.PORT ?? 8080}`;
    stoppers.push(startWebhookWorker(data, { signer: playbackSigner, base: workerBase, ttlSeconds: options.playbackTtlSeconds ?? 900 }, app.log));
  }
  // Any other /v1 route answers 501.
  app.all("/v1/*", async (req, reply) =>
    reply.code(501).send(errorBody("not_implemented", "this endpoint is not implemented", String(req.id))),
  );

  let internal: FastifyInstance | undefined;
  if (options.internalPort !== undefined) {
    internal = build("internal");
    // The internal listener is off the public network, so it always serves metrics.
    internal.get("/metrics", async (_req, reply) => {
      reply.header("content-type", registry.contentType);
      return registry.metrics();
    });
  }

  for (const m of modules) {
    if (m.publicRoutes) await app.register(async (scope) => m.publicRoutes!(scope, ctx));
    if (m.internalRoutes) {
      if (!internal) throw new Error(`module ${m.name} has internal routes but no internalPort was set`);
      await internal.register(async (scope) => m.internalRoutes!(scope, ctx));
    }
  }


  return {
    public: app,
    internal,
    data,
    async recordUsage(record) {
      for (const m of modules) await m.onUsage?.(record);
    },
    quotaFor,
    async listen({ port, host = "0.0.0.0" }) {
      await app.listen({ port, host });
      if (internal) await internal.listen({ port: options.internalPort!, host: process.env.INTERNAL_HOST ?? "127.0.0.1" });
    },
    async close() {
      for (const stop of stoppers) stop();
      await bus?.close();
      await app.close();
      await internal?.close();
      if (ownsDb) await db.destroy();
    },
  };
}
