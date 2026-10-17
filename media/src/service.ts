// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The open-source media plane (ADR 0050): one image, two roles. The ingress
// role is signalling, WHIP, viewers and the control API; the egress role runs
// cameras' continuous feeds. One process runs both by default; MEDIA_ROLES
// splits them. Nothing here knows about Senseplane accounts, buckets or brains.
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import * as mediasoup from "mediasoup";
import { Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { logMixin } from "@senseplane/telemetry";
import { RoomEvents } from "./callbacks.js";
import { type MediaConfig, loadConfig } from "./config.js";
import { registerControl } from "./control.js";
import { type EgressDispatcher, localDispatcher, registerEgressApi, remoteDispatcher } from "./egress/dispatch.js";
import { EgressManager } from "./egress/manager.js";
import { registerReplay } from "./replay.js";
import { RoomManager, type WorkerNode } from "./rooms.js";
import { attachSignalling } from "./signalling.js";
import { registerMediaMetrics } from "./telemetry.js";
import { ReplayGuard, keyObjects } from "./tokens.js";
import { registerWhip } from "./whip.js";

export interface MediaServiceOptions {
  config?: Partial<MediaConfig>;
  workers?: number;
  logger?: FastifyServerOptions["logger"];
  /** Callbacks and presigned uploads (tests). */
  fetch?: typeof fetch;
}

export interface MediaService {
  app: FastifyInstance;
  config: MediaConfig;
  rooms?: RoomManager;
  egress?: EgressManager;
  workers: mediasoup.types.Worker[];
  listen(): Promise<void>;
  close(): Promise<void>;
}

export async function createMediaService(options: MediaServiceOptions = {}): Promise<MediaService> {
  const config: MediaConfig = { ...loadConfig(), ...options.config };
  if (options.workers) config.workers = options.workers;
  const logger = options.logger ?? { level: process.env.LOG_LEVEL ?? "info", mixin: logMixin };
  const app = Fastify({ logger, genReqId: () => randomUUID(), bodyLimit: 1024 * 1024, routerOptions: { maxParamLength: 512 } });
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const ingress = config.roles.has("ingress");
  const workers: mediasoup.types.Worker[] = [];
  const nodes: WorkerNode[] = [];

  if (ingress) {
    for (let i = 0; i < config.workers; i++) {
      const worker = await mediasoup.createWorker({ logLevel: "warn" });
      worker.on("died", (e) => app.log.error({ err: e, pid: worker.pid }, "mediasoup worker died"));
      let webRtcServer: mediasoup.types.WebRtcServer | undefined;
      if (config.rtcPort > 0) {
        const listen = { ip: config.listenIp, ...(config.announcedAddress ? { announcedAddress: config.announcedAddress } : {}), port: config.rtcPort + i };
        const internal = config.internalAddress && config.internalAddress !== config.announcedAddress
          ? { ip: config.listenIp, announcedAddress: config.internalAddress, port: config.rtcInternalPort + i } : undefined;
        webRtcServer = await worker.createWebRtcServer({ listenInfos: [
          { protocol: "udp", ...listen }, { protocol: "tcp", ...listen },
          ...(internal ? [{ protocol: "udp" as const, ...internal }, { protocol: "tcp" as const, ...internal }] : []),
        ] });
      }
      workers.push(worker);
      nodes.push({ worker, ...(webRtcServer ? { webRtcServer } : {}) });
    }
  }
  const alive = () => workers.filter((w) => !w.died && !w.closed).length;

  let egress: EgressManager | undefined;
  if (config.roles.has("egress")) {
    egress = new EgressManager({
      ffmpegPath: config.ffmpegPath, workDir: config.workDir, rtpIp: config.egress.rtpIp, rtpAnnouncedAddress: config.egress.rtpAnnouncedAddress,
      signalUrl: config.egress.signalUrl, log: app.log, maxSessions: config.egress.maxSessions, callbackTimeoutMs: config.egress.callbackTimeoutMs,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    // A separate egress host takes jobs from the ingress over HTTP (ADR 0050).
    if (config.egress.secret) registerEgressApi(app, egress, config.egress.secret);
  }

  let rooms: RoomManager | undefined;
  let signalling: ReturnType<typeof attachSignalling> | undefined;
  let replay: ReturnType<typeof registerReplay> | undefined;
  if (ingress) {
    const ring = { issuer: config.instanceId, keys: keyObjects(config.publicKeys), maxTtlSeconds: config.joinMaxTtlSeconds, skewSeconds: config.clockSkewSeconds };
    const replayGuard = new ReplayGuard();
    rooms = new RoomManager(nodes, config, app.log, new RoomEvents({ log: app.log, ...(options.fetch ? { fetch: options.fetch } : {}) }));
    const join = { rooms, ring, replay: replayGuard, log: app.log };
    signalling = attachSignalling(app.server, { ...join, joinDeadlineMs: config.joinDeadlineMs });
    registerWhip(app, { ...join, cfg: config.whip, ...(options.fetch ? { fetch: options.fetch } : {}) });
    const dispatcher: EgressDispatcher | undefined = egress
      ? localDispatcher(egress, () => config.egress.signalUrl)
      : config.egress.url && config.egress.secret ? remoteDispatcher(config.egress.url, config.egress.secret, () => config.egress.signalUrl) : undefined;
    registerControl(app, { rooms, ring, replay: replayGuard, mediaUrl: () => config.mediaUrl, ...(dispatcher ? { egress: dispatcher } : {}), healthy: () => alive() === workers.length });
    if (config.devReplay) replay = registerReplay(app, { ...join, ffmpegPath: config.ffmpegPath });
  }

  registerMediaMetrics(registry, {
    workers,
    liveProducers: () => rooms?.usage().producers ?? 0,
    recorders: () => egress?.live() ?? 0,
    feeds: () => egress?.live() ?? 0,
  });
  const workersAlive = new Gauge({ name: "senseplane_media_workers_alive", help: "Live mediasoup workers", registers: [registry] });
  new Gauge({ name: "senseplane_media_rooms", help: "Live rooms on this node", registers: [registry], collect() { this.set(rooms?.usage().rooms ?? 0); } });
  new Gauge({ name: "senseplane_media_participants", help: "Participants on this node", registers: [registry], collect() { this.set(rooms?.usage().participants ?? 0); } });

  app.get("/healthz", async (_req, reply) => {
    workersAlive.set(alive());
    if (alive() !== workers.length) return reply.code(503).send({ status: "degraded", workers: alive() });
    return { status: "ok", roles: [...config.roles], workers: alive(), ...(egress ? { feeds: egress.live() } : {}) };
  });
  // /metrics is for the operator: a bearer METRICS_TOKEN when set; never public in production.
  app.get("/metrics", async (req, reply) => {
    const token = process.env.METRICS_TOKEN;
    const production = process.env.NODE_ENV === "production" || process.env.SENSEPLANE_MODE === "production";
    if (token ? req.headers.authorization !== `Bearer ${token}` : production) return reply.code(404).send({ error: "not found" });
    workersAlive.set(alive());
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });

  return {
    app, config, workers,
    ...(rooms ? { rooms } : {}),
    ...(egress ? { egress } : {}),
    async listen() {
      await app.listen({ port: config.port, host: "0.0.0.0" });
    },
    async close() {
      await rooms?.drain(0);
      replay?.stopAll();
      await egress?.close();
      await signalling?.close();
      rooms?.close();
      await app.close();
      for (const w of workers) w.close();
    },
  };
}
