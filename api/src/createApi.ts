// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { type Kysely, sql } from "kysely";
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
import { effectiveBlur, requireBlurringBrains } from "./blur.js";
import { checkRole } from "./roles.js";
import { purgeDeletedAccounts } from "./purge.js";
import { registerTrustRoutes } from "./routes/trust.js";
import { registerAppRoutes } from "./routes/apps.js";
import { enforceLimits, isIngestMeter, overLimits, registerUsageRoutes, sampleStorage } from "./routes/usage.js";
import { republishWatches, watchKv } from "./routes/watches.js";
import { demoConfig, registerDemoRoutes, sweepDemos } from "./routes/demo.js";
import { registerSourceConfigRoutes } from "./routes/source-config.js";
import { registerReadingsWebhook } from "./routes/readings-webhook.js";
import { registerBridgeOutputRoutes } from "./routes/bridge-outputs.js";
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
import { closeViewers, registerLiveRoutes, sweepLiveSessions } from "./routes/live.js";
import { markSilentBridges, registerBridgeAdminRoutes, registerBridgeRoutes } from "./routes/bridges.js";
import { registerPairingRoutes } from "./routes/pairing.js";
import { expireConfirmations, registerDeviceRoutes, sweepLostCommands } from "./routes/devices.js";
import { closeStaleActivities } from "./activity.js";
import { startScheduledWatches } from "./scheduled-watches.js";
import { type Job, startJobs } from "./jobs.js";
import {
  type ChannelDeps, notifyConfirmation, registerChannelRoutes, startChannelSender, startTelegramUpdates, telegramPollJob, telegramWebhookJob,
} from "./channels.js";
import { type TelegramConfig, TelegramBot, telegramConfigFromEnv } from "./telegram.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerPlaybackRoutes } from "./routes/playback.js";
import { makeStory, registerStoryRoutes } from "./routes/stories.js";
import { startStoryWorker, toStory } from "./stories.js";
import { killAllFfmpeg, sweepWorkDirs } from "./ffmpeg.js";
import { registerFollowRoutes } from "./routes/follows.js";
import { startFollowWorker } from "./follow.js";
import { createKeyRefSealer, createPlaybackSigner, newPlaybackSecret } from "./playback.js";
import { createMediaGuard, mediaClaims } from "./media-access.js";
import { metricsAllowed, registerRateLimits, trustProxyFromEnv } from "./rate-limit.js";
import { hashApiKey } from "./data/access.js";
import type { FastifyRequest } from "fastify";
import { type KeyWrapper, createKeyRing, envKeyWrapper, newMediaKey } from "./keys.js";
import { reencryptKeys, rewrapKeys } from "./rotation.js";
import { type ObjectStorage, type StorageConfig, createObjectStorage, encryptingStorage } from "./storage.js";
import { sweepOnce } from "./sweeper.js";
import { isProduction } from "./ingest.js";
import { createSecretBox, newSecretsKey } from "./secret-box.js";
import { expireIdempotencyKeys, registerIdempotency } from "./idempotency.js";
import { registerTeamRoutes } from "./routes/team.js";
import { registerSpeakRoutes } from "./routes/speak.js";
import { type Speech, type TtsConfig, createSpeech, startSpeechWorker, sweepLostSpeech, ttsConfigFromEnv } from "./speak.js";
import { type AuthConfig, authConfig, httpOAuthClient, type OAuthClient, registerAuthRoutes } from "./routes/auth.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { type WorkflowEngine, createWorkflowEngine, pruneWorkflowRuns, startWorkflowWorker } from "./workflows.js";
import type { WebhookSender } from "./workers.js";

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
  /** The bridge image named in the `docker run` command for RTSP cameras (default `ghcr.io/senseplane-ai/bridge:0.2`, the release line, or BRIDGE_IMAGE). ADR 0045. */
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
  /** Master key for footage encrypted at rest (MEDIA_ENCRYPTION_KEY, ADR 0066); generated and stored outside production if unset. */
  mediaEncryptionKey?: string;
  /** Wraps account data keys instead of MEDIA_ENCRYPTION_KEY (a KMS, for hosted). */
  keyWrapper?: KeyWrapper;
  /** HMAC secret for playback URLs; generated and stored outside production if unset. */
  playbackSecret?: string;
  /** Playback URL lifetime (default 900 s). */
  playbackTtlSeconds?: number;
  /** Retention sweep interval; 0 disables the background sweeper (default 600 s). */
  sweepIntervalSeconds?: number;
  /** Background work (jobs, scheduled watches, deliveries, clips; ADR 0058); default on. Off for processes that only serve requests, and in tests. */
  workers?: boolean;
  /** A bus to use instead of connecting to valkeyUrl (tests). */
  bus?: ApiBus;
  /** Telegram (ADR 0059); default from TELEGRAM_BOT_TOKEN and TELEGRAM_*; false turns it off. */
  telegram?: TelegramConfig | false;
  /** Telegram API calls (tests inject a fake). */
  telegramFetch?: typeof fetch;
  /** Device commands (ADR 0067): how long a box has to take one, a request waits, and a person has to confirm (tests shorten them). */
  deviceTimings?: { takeMs?: number; waitMs?: number; confirmMs?: number };
  /** Text to speech for talk-back (ADR 0069); default from TTS_BASE_URL, TTS_API_KEY, TTS_MODEL and TTS_VOICE. false turns it off. */
  tts?: TtsConfig | false;
  /** Shorter waits for a box to take and play a message, in tests. */
  speakTimings?: { takeMs?: number; waitMs?: number };
  /** Sends a workflow's webhook step (tests inject one; default the guarded egress, ADR 0035). */
  workflowSender?: WebhookSender;
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
  /** A person's answer to a device request waiting for confirmation (ADR 0067); Telegram's buttons use it. */
  decideConfirmation: NonNullable<ChannelDeps["decideConfirmation"]>;
  /** Talk-back (ADR 0069): says the watch messages waiting (the speech worker does this when workers run). */
  speech: Pick<Speech, "runQueued">;
  /** Workflows (ADR 0072): runs what is due and fires due schedules (the workflow worker does this when workers run). */
  workflows: Pick<WorkflowEngine, "runDue" | "fireSchedules">;
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
    if (req.url.startsWith("/v1/workflow-hooks/")) return; // a workflow's own signature, checked by its route (ADR 0072)
    const header = req.headers.authorization ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (key.startsWith("sit_")) {
      // Sensor integration token (Home Assistant): readings for one source only, see checkRoute.
      const p = await data.authenticateIntegrationToken(key);
      if (!p) throw new ApiError(401, "unauthorized", "unknown or revoked integration token");
      req.accountId = p.accountId;
      req.access = { actor: `integration:${key.slice(0, 8)}`, integrationSource: p.sourceId, integrationToken: { id: p.tokenId, signingSecret: p.signingSecret }, keyHash: hashApiKey(key) };
      return;
    }
    const principal = key ? await data.authenticate(key) : undefined;
    if (!principal) throw new ApiError(401, "unauthorized", "a valid API key is required");
    req.accountId = principal.accountId;
    if (principal.agentId) {
      // Read on every request, so a revoked grant stops working on the next one (ADR 0024).
      const grants = await data.withAccount(principal.accountId, (s) =>
        s.db.selectFrom("grants").select(["source_ids", "senses", "window_from", "window_to", "abilities", "blurred_only"]).where("agent_id", "=", principal.agentId!).execute());
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
    if ((route === "POST /v1/sources/:id/ask" || route === "POST /v1/watches" || route === "POST /v1/watches/test" || route === "POST /v1/conversations/:id/messages" || route === "POST /v1/follows") && (await over(req.accountId!, (m) => m === "ai_checks"))) {
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
  // Footage encrypted at rest with keys the server holds (ADR 0066): snapshots and exports sealed by the
  // storage layer, recording segments by the media plane with keys handed out per upload.
  let mediaKey = options.mediaEncryptionKey ?? process.env.MEDIA_ENCRYPTION_KEY;
  if (!mediaKey && !options.keyWrapper) {
    if (isProduction()) throw new Error("MEDIA_ENCRYPTION_KEY is required in production");
    mediaKey = (await data.secrets.get("media_encryption_key")) ?? (await data.secrets.putIfAbsent("media_encryption_key", newMediaKey()));
  }
  // A master key rotation keeps the old key(s) here until the rewrap job has moved every account (ADR 0066).
  const previousMediaKeys = (process.env.MEDIA_ENCRYPTION_KEY_PREVIOUS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const keyWrapper = options.keyWrapper ?? envKeyWrapper(mediaKey!, previousMediaKeys);
  const keyRing = createKeyRing(data, keyWrapper);
  const plainStorage = options.storage ? ("deleteMany" in options.storage ? options.storage : createObjectStorage(options.storage)) : undefined;
  const storage = plainStorage ? encryptingStorage(plainStorage, keyRing) : undefined;
  let bus: ApiBus | undefined = options.bus;
  if (!bus && options.valkeyUrl) bus = await startBus(options.valkeyUrl, data, storage, app.log);
  const valkeyBus = bus && "publishMedia" in bus ? (bus as ValkeyBus) : undefined;
  const masks = new MaskCache(data);
  valkeyBus?.onSourceChanged((key) => masks.invalidate(key));
  const publishConfig = async (accountId: string, src: Source) => {
    masks.invalidate(`${accountId}.${src.id}`);
    // Privacy blurring (ADR 0068): the brain gets the camera's effective setting, source over account.
    const blur = effectiveBlur(src, await data.withAccount(accountId, (s) => s.account.get()));
    await bus?.putSourceConfig(accountId, src.id, { zones: src.zones ?? [], privacy_masks: src.privacy_masks ?? [], record_audio: src.record_audio, blur });
  };
  /** The account's blurring changed: every camera that follows it gets its new effective setting. */
  const publishAllConfigs = async (accountId: string) => {
    for (const src of await data.withAccount(accountId, (s) => s.sources.list())) {
      await publishConfig(accountId, src).catch((err) => app.log.warn({ err, account: accountId, source: src.id }, "source config publish failed; the next sweep sends it again"));
    }
  };
  /**
   * Every camera's config again (on start and every few minutes, ADR 0068): blurring that failed to reach
   * the brain once (Valkey down during a PATCH) never stays off there. Cheap: one hash write per camera.
   */
  const republishAllConfigs = async () => {
    if (!bus) return;
    const rows = (await sql<{ account_id: string }>`select * from accounts_with_cameras()`.execute(data.db())).rows;
    for (const r of rows) await publishAllConfigs(r.account_id);
  };
  /** A stored snapshot blurred by a brain, for a blurred-only agent (rpc.brain.redact). */
  const redactSnapshot = async (accountId: string, sourceId: string, jpeg: Buffer) => {
    await requireBlurringBrains(bus, true);
    const out = await bus?.request<{ jpeg_b64?: string; error?: string }>("rpc.brain.redact", { account_id: accountId, source_id: sourceId, jpeg_b64: jpeg.toString("base64") }, 20_000)
      .catch(() => undefined);
    if (!out?.jpeg_b64) throw new ApiError(503, "service_unavailable", "this snapshot can only be served blurred, and the brain did not answer");
    return Buffer.from(out.jpeg_b64, "base64");
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
  registerConversationRoutes(app, {
    data, bus, storage, urls: eventUrls, checkHistory: watchRoutes.test,
    // The chat's make_story (ADR 0070): the same checks as POST /v1/stories.
    ...(storage ? { makeStory: async (req, input) => { const out = await makeStory({ data, bus, audit }, req, input); return toStory(out.story, out.pieces); } } : {}),
  });
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
  // Talk-back (ADR 0069): agents' and watches' messages, and people's push-to-talk.
  const tts = options.tts === false ? undefined : options.tts ?? ttsConfigFromEnv();
  const speech = createSpeech({ data, storage, media: mediaControl, audit, signer: playbackSigner, log: app.log, ...(tts ? { tts } : {}), ...options.speakTimings });
  registerSpeakRoutes(app, { data, speech, audit, signer: playbackSigner, base, ttlSeconds: options.playbackTtlSeconds ?? 900 });
  const maxResolutionFor = async (id: string) => (await quotaFor(id)).maxResolution ?? "720p";
  registerMediaCallbacks(app, {
    data, signer, storage, media: mediaControl, masks, log: app.log, keys: keyRing,
    onTalk: (accountId, sourceId, sessionId, event, at) => speech.personTalk(accountId, sourceId, sessionId, event, at),
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
  registerTrustRoutes(app, {
    data, storage, urls: eventUrls, keys: keyRing,
    onGrantsChanged: async (accountId, change) => {
      // Live video is raw: a new blurred-only grant ends that agent's viewers there now, not at their idle timeout.
      for (const sourceId of change.blurredOnlySources ?? []) {
        await closeViewers(data, mediaControl, accountId, "blurred_only", { sourceId, actor: `agent:${change.agentId}` });
      }
      await republishWatches(data, bus, accountId);
    },
  });
  // Telegram chats: alerts and questions (ADR 0059).
  const telegramConfig = options.telegram === false ? undefined : options.telegram ?? telegramConfigFromEnv();
  const channels: ChannelDeps = {
    data, app, storage, audit, log: app.log, consoleUrl: auth.consoleUrls[0], redact: redactSnapshot,
    ...(telegramConfig ? { bot: new TelegramBot(telegramConfig, options.telegramFetch) } : {}),
  };
  registerChannelRoutes(channels);
  // Connected apps: MCP consent creates agents, the MCP service redeems their keys (ADR 0048).
  registerAppRoutes(app, { data, audit });
  registerUsageRoutes(app, { data, quotaFor });
  registerDemoRoutes(app, { data, bus, media: mediaControl, signer, storage, urls: eventUrls, apiPublicUrl: options.apiPublicUrl, config: demo, ipSalt });
  registerSourceConfigRoutes(app, { data, signer: playbackSigner, base, maxRetentionDays, publishConfig, keyRefs, storageCap: async (id) => (await quotaFor(id)).storageCapBytes });
  // The readings webhook for IFTTT, n8n, Zapier, ESPHome, Shelly and scripts (ADR 0071).
  registerReadingsWebhook(app, { data, base: (req) => options.apiPublicUrl ?? `${req.protocol}://${req.host}` });
  const storageCap = async (accountId: string) => (await quotaFor(accountId)).storageCapBytes;
  registerAccountRoutes(app, { data, maxRetentionDays, storageCap, quotaFor, onBlurChanged: publishAllConfigs });
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
    data, maxSources: async (id) => (await quotaFor(id)).maxSources, maxResolution: maxResolutionFor, audit,
    onSpeakReported: (accountId, id, ok, error, result) => speech.boxReported(accountId, id, ok, error, result),
    ...(mediaDriver?.publicUrl ? { whip: { publicUrl: mediaDriver.publicUrl, authorizeUrl: whipAuthorizeUrl, signer } } : {}),
  });
  registerBridgeAdminRoutes(app, { data, maxSources: async (id) => (await quotaFor(id)).maxSources, maxResolution: maxResolutionFor, audit,
    ...(mediaDriver?.disconnect ? { disconnect: (id: string) => mediaDriver.disconnect!(id, "removed") } : {}) });
  // MQTT out through a box, only when the account turns it on for that box (ADR 0071).
  registerBridgeOutputRoutes(app, { data, audit });
  registerPairingRoutes(app, { data, audit, ...(auth.consoleUrls[0] ? { consoleUrl: auth.consoleUrls[0] } : {}) });
  // Switching devices, only when a person asks (ADR 0067); requests waiting for a person also go to linked chats.
  const devices = registerDeviceRoutes(app, { data, audit, ...options.deviceTimings, onConfirmation: (accountId, c, where) => notifyConfirmation(channels, accountId, c, where) });
  channels.decideConfirmation = devices.decide;
  const stoppers: (() => void | Promise<void>)[] = [];
  // Workflows (ADR 0072): a trigger and steps that tell, ask, speak, clip and wait; never switching a device.
  const workflows = createWorkflowEngine({
    data, bus, storage, audit, speech, log: app.log, ...(options.workflowSender ? { send: options.workflowSender } : {}),
    checksUsedUp: (id) => over(id, (m) => m === "ai_checks"),
  });
  registerWorkflowRoutes(app, { data, audit, base, cancel: (accountId, id, by) => workflows.cancel(accountId, id, by) });
  if (storage) {
    registerPlaybackRoutes(app, {
      data, storage, signer: playbackSigner, apiPublicUrl: options.apiPublicUrl, ttlSeconds: options.playbackTtlSeconds ?? 900,
      keyRefs, guard: mediaGuard, keys: keyRing,
      latestSnapshot: bus ? (a, s) => bus!.latestSnapshot(a, s) : undefined,
      ...(bus ? { redactSnapshot } : {}),
    });
    if (options.workers !== false) stoppers.push(startClipWorker(data, storage, app.log));
    // Stories (ADR 0070): rendered by a background job, played through the same signed links.
    registerStoryRoutes(app, { data, storage, signer: playbackSigner, apiPublicUrl: options.apiPublicUrl, ttlSeconds: options.playbackTtlSeconds ?? 900, keyRefs, bus, audit });
    if (options.workers !== false) {
      // Work dirs a process that died mid-render left behind (ADR 0070): nothing decrypted may linger.
      void sweepWorkDirs().then((n) => n && app.log.info({ removed: n }, "swept leftover story and follow work dirs"), (err) => app.log.warn({ err }, "work dir sweep failed"));
      stoppers.push(startStoryWorker({ data, storage, keys: keyRing, bus }, app.log));
    }
    // Following an object or a pet (ADR 0070): a background job reads the recordings, a brain looks.
    registerFollowRoutes(app, { data, storage, keys: keyRing, bus, audit, signer: playbackSigner, apiPublicUrl: options.apiPublicUrl, ttlSeconds: options.playbackTtlSeconds ?? 900, keyRefs });
    const checksUsedUp = (id: string) => over(id, (m) => m === "ai_checks");
    if (options.workers !== false) stoppers.push(startFollowWorker({ data, storage, keys: keyRing, bus, audit, checksUsedUp }, app.log));
  }
  if (options.workers !== false) {
    // Housekeeping, each job once per interval across every API process (ADR 0058).
    const sweepEvery = options.sweepIntervalSeconds ?? 600;
    const jobs: Job[] = [
      { name: "demos.sweep", everyS: 30, run: () => sweepDemos({ data, bus, media: mediaControl, storage }, demo, app.log) },
      { name: "watches.expire", everyS: 30, run: () => expireWatches(data, bus) },
      { name: "bridges.silent", everyS: 30, run: () => markSilentBridges(data, app.log) },
      // Refuses device requests nobody confirmed in two minutes, and gives up on ones a box never reported; it never switches anything.
      { name: "devices.confirmations", everyS: 15, run: async () => (await expireConfirmations(data, audit)) + (await sweepLostCommands(data, audit)) },
      // Box messages never reported are given up (ADR 0069); it never plays anything.
      { name: "speak.lost", everyS: 30, run: () => sweepLostSpeech(data, audit) },
      { name: "activities.close_stale", everyS: 30, run: () => closeStaleActivities(data) },
      { name: "accounts.purge", everyS: 30, leaseS: 1800, run: () => purgeDeletedAccounts({ data, bus, storage }, app.log) },
      // Key rotation (ADR 0066): accounts mid-rotation get their footage re-encrypted; old master keys re-wrapped.
      ...(plainStorage ? [{ name: "keys.reencrypt", everyS: 30, leaseS: 300, run: () => reencryptKeys({ data, storage: plainStorage, keys: keyRing, wrapper: keyWrapper, log: app.log }, 45_000) }] : []),
      ...(previousMediaKeys.length && plainStorage ? [{ name: "keys.rewrap", everyS: 600, run: () => rewrapKeys({ data, storage: plainStorage, keys: keyRing, wrapper: keyWrapper, log: app.log }) }] : []),
      // Live sessions the media plane stopped reporting (3 missed minute reports) are closed and metered.
      ...(mediaDriver ? [{ name: "media.feeds", everyS: 30, run: () => mediaDriver.sweepFeeds() }] : []),
      { name: "storage.sample", everyS: 3600, run: () => sampleStorage(data) },
      { name: "idempotency.expire", everyS: 3600, run: () => expireIdempotencyKeys(data) },
      { name: "workflows.prune", everyS: 3600, run: () => pruneWorkflowRuns(data) },
      { name: "sources.republish", everyS: 300, run: () => republishAllConfigs() },
      {
        name: "usage.limits", everyS: 30,
        run: async (state) => {
          const now = await enforceLimits({ data, bus, media: mediaControl, quotaFor, log: app.log,
            onUsageLimit: async (a, m, u, l) => { for (const mod of modules) await mod.onUsageLimit?.(a, m, u, l); } });
          // Back under every limit (a new day or month, or a raised limit): resume watches.
          for (const id of (state as { over?: string[] } | null)?.over ?? []) {
            if (now.has(id)) continue;
            const rows = await data.withAccount(id, (s) => s.db.selectFrom("watches").selectAll().where("status", "=", "active").execute());
            for (const w of rows) await bus?.putWatch(id, w.id, await watchKv(data, id, w));
          }
          return { over: [...now.keys()] };
        },
      },
      // Live viewers: idle close, camera gone, metering (ADR 0042, 0049); its own cadence, as the idle timeout can be short.
      { name: "live.sessions", everyS: Number(process.env.LIVE_SWEEP_SECONDS ?? 10), leaseS: 60,
        run: () => sweepLiveSessions(data, { idleTimeoutSeconds: liveIdleTimeoutSeconds, media: mediaControl, log: app.log }) },
      ...(storage && sweepEvery > 0 ? [{
        name: "retention.sweep", everyS: sweepEvery, leaseS: 3600,
        run: async () => {
          const got = await sweepOnce(data, storage, new Date(), async (id) => (await quotaFor(id)).storageCapBytes);
          if (got.segments) app.log.info({ sweep: got }, "retention sweep deleted raw segments");
        },
      }] : []),
    ];
    if (channels.bot) {
      if (channels.bot.config.mode === "polling") jobs.push(telegramPollJob(channels));
      else if (options.apiPublicUrl) jobs.push(telegramWebhookJob(channels, options.apiPublicUrl.replace(/\/$/, "")));
      stoppers.push(startTelegramUpdates(channels));
    }
    stoppers.push(startChannelSender(channels));
    stoppers.push(startSpeechWorker(speech, app.log));
    stoppers.push(startWorkflowWorker(workflows, app.log));
    stoppers.push(startJobs(data, jobs, app.log));
    stoppers.push(startScheduledWatches(data, app.log));
    // Deliveries are built outside a request, so links use the configured public URL.
    const workerBase = options.apiPublicUrl ?? `http://localhost:${process.env.PORT ?? 8080}`;
    stoppers.push(startWebhookWorker(data, { signer: playbackSigner, base: workerBase, ttlSeconds: options.playbackTtlSeconds ?? 900 }, app.log));
  }
  // Blurring settings reach the brain on every start, whatever happened while no API was up (ADR 0068);
  // the sources.republish job keeps sending them every few minutes.
  if (bus) void republishAllConfigs().catch((err) => app.log.warn({ err }, "republishing source configs on start failed"));
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
    decideConfirmation: devices.decide,
    speech,
    workflows,
    async listen({ port, host = "0.0.0.0" }) {
      await app.listen({ port, host });
      if (internal) await internal.listen({ port: options.internalPort!, host: process.env.INTERNAL_HOST ?? "127.0.0.1" });
    },
    async close() {
      // A render or follow in flight is stopped (its claim runs out and another process takes it over, ADR 0070);
      // then background work finishes what it started before the database closes (ADR 0058).
      killAllFfmpeg();
      await Promise.all(stoppers.map((stop) => stop()));
      await bus?.close();
      await app.close();
      await internal?.close();
      if (ownsDb) await db.destroy();
    },
  };
}
