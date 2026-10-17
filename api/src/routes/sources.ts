// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import { seesSource } from "../access.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Source } from "../data/access.js";
import type { DataAccess } from "../data/access.js";
import { ApiError } from "../errors.js";
import { type CaptureTicket, type IngestSigner, UNBOUND_TICKET_SECONDS } from "../ingest.js";
import { roomFor } from "../ingest.js";
import type { MediaControl } from "../media-driver.js";
import { createHash } from "node:crypto";
import { hashApiKey } from "../data/access.js";
import type { AuditLog } from "../module.js";

export interface SourcesDeps {
  data: DataAccess;
  signer: IngestSigner;
  media: MediaControl;
  /** Base URL of the capture page, e.g. https://console.example.com/capture.html */
  captureUrl: string;
  /** Public base URL of this API as the capture page should call it; defaults to the request's origin. */
  apiPublicUrl?: string;
  ticketTtlSeconds: number;
  joinTtlSeconds: number;
  maxSources(accountId: string): Promise<number | null>;
  maxActiveSources?(accountId: string): Promise<number | null>;
  /** True when the account is over an ingest or storage usage limit (ADR 0025). */
  ingestBlocked?(accountId: string): Promise<boolean>;
  /** The account's maximum recording resolution (ADR 0022). */
  maxResolution?(accountId: string): Promise<"720p" | "1080p">;
  maxRetentionDays(accountId: string): Promise<number | null>;
  /** Shares zones and masks with the brain (Valkey), when it is configured. */
  publishConfig?(accountId: string, source: Source): Promise<void>;
  /** Where a WHIP bearer sends the media plane to authorise a publish (API_CALLBACK_URL + /internal/media/whip-authorize). */
  whipAuthorizeUrl?: string;
  audit?: AuditLog;
  /** The bridge's container image in the `docker run` command shown for RTSP cameras (ADR 0045). */
  bridgeImage?: string;
}

export const newBridgeToken = () => `brg_${randomBytes(24).toString("base64url")}`;
export const newIntegrationToken = () => `sit_${randomBytes(24).toString("base64url")}`;
const SENSOR_SENSES = ["temperature", "humidity"] as const;
/** RTSP credentials never leave in error details or listings. */
export const redactUrls = (text: string) => text.replace(/(rtsps?:\/\/)[^/@\s]*@/gi, "$1***@");

/** A paused camera takes no pushes until it is resumed. */
function refusePaused(source: Source) {
  if (source.status === "paused") throw new ApiError(409, "conflict", "This camera is paused. Resume it to record again.", { reason: "paused" });
}

/** Shapes a row as the public Source schema (spec/schemas/source.json). */
/** An agent sees a source with only the senses it was ever granted on it (ADR 0024). */
export function grantedView<T extends { id: string; senses: string[] }>(req: FastifyRequest, s: T): T {
  const grants = req.access?.grants;
  if (!grants) return s;
  const allowed = new Set(grants.filter((g) => g.source_ids.includes(s.id)).flatMap((g) => g.senses));
  return { ...s, senses: s.senses.filter((x) => allowed.has(x)) };
}

export function toSource(row: Source, maxResolution?: "720p" | "1080p") {
  const thresholds = row.sensor_thresholds ?? null;
  return {
    id: row.id,
    name: row.name,
    ...(row.location ? { location: row.location } : {}),
    type: row.type,
    senses: row.senses,
    status: row.status,
    record_audio: row.record_audio,
    retention_days: row.retention_days,
    retention_mode: row.retention_mode ?? null,
    retention_max_bytes: row.retention_max_bytes == null ? null : Number(row.retention_max_bytes),
    zones: row.zones ?? [],
    privacy_masks: row.privacy_masks ?? [],
    sensor_thresholds: thresholds,
    status_since: row.status_since ? new Date(row.status_since).toISOString() : null,
    ...(row.type === "rtsp" ? { bridge_id: row.bridge_id ?? null, status_detail: row.bridge_detail ? redactUrls(row.bridge_detail) : null } : {}),
    ...(row.type !== "sensor" ? { view_changed_at: row.view_changed_at ? new Date(row.view_changed_at).toISOString() : null } : {}),
    ...(maxResolution && row.type !== "sensor" ? { max_resolution: maxResolution } : {}),
    created_at: new Date(row.created_at).toISOString(),
  };
}

const createBody = {
  type: "object",
  additionalProperties: false,
  required: ["name", "type"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    location: { type: "string", maxLength: 120 },
    type: { type: "string", enum: ["browser", "sensor", "whip", "rtsp"] },
    record_audio: { type: "boolean", default: false },
    retention_days: { type: ["integer", "null"], minimum: 1 },
    senses: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...SENSOR_SENSES] } },
    rtsp_url: { type: "string", maxLength: 2048, pattern: "^rtsps?://" },
    bridge_id: { type: "string", minLength: 1, maxLength: 64 },
  },
} as const;

type CreateBody = {
  name: string; location?: string; type: "browser" | "sensor" | "whip" | "rtsp"; record_audio?: boolean; retention_days?: number | null;
  senses?: string[]; rtsp_url?: string; bridge_id?: string;
};

export function registerSourceRoutes(app: FastifyInstance, deps: SourcesDeps) {
  /**
   * Capture links are bound to the first device that joins with them (ADR 0038):
   * a link from an older epoch (rotated) is refused; an unbound link must be used
   * within UNBOUND_TICKET_SECONDS of issue; a bound link only works for its device.
   * A join without `device` works only while unbound and
   * within that first window, and doesn't bind.
   */
  const bindDevice = async (accountId: string, source: Source, ticket: CaptureTicket, device: string | undefined) => {
    const row = source as Source & { capture_epoch?: number; capture_device_hash?: string | null };
    if ((ticket.epoch ?? 0) !== (row.capture_epoch ?? 0)) throw new ApiError(401, "unauthorized", "this capture link was replaced; open the newest link for this camera");
    const hash = device ? createHash("sha256").update(device).digest("hex") : undefined;
    if (row.capture_device_hash) {
      if (hash !== row.capture_device_hash) throw new ApiError(401, "unauthorized", "this capture link is already in use on another device; create a new link for this camera");
      return;
    }
    const fresh = Date.now() / 1000 - (ticket.issuedAt ?? 0) <= UNBOUND_TICKET_SECONDS;
    if (!fresh) throw new ApiError(401, "unauthorized", "this capture link has expired before first use; create a new link for this camera");
    if (!hash) return;
    const bound = await deps.data.withAccount(accountId, (s) =>
      s.db.updateTable("sources").set({ capture_device_hash: hash, capture_bound_at: new Date() })
        .where("id", "=", source.id).where("capture_device_hash", "is", null).where("capture_epoch", "=", ticket.epoch ?? 0)
        .executeTakeFirst());
    if (!bound.numUpdatedRows) {
      // Another device bound it first.
      const now = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("sources").select("capture_device_hash").where("id", "=", source.id).executeTakeFirst());
      if (now?.capture_device_hash !== hash) throw new ApiError(401, "unauthorized", "this capture link is already in use on another device; create a new link for this camera");
    }
  };
  const whipEnabled = () => Boolean(deps.media.publicUrl && deps.whipAuthorizeUrl);
  const whipUrl = (sourceId: string) => `${deps.media.publicUrl!.replace(/\/$/, "")}/whip/${encodeURIComponent(sourceId)}`;
  /**
   * Revokes the source's live WHIP bearers and, when `issue`, stores a new one (returned in clear once).
   * The bearer is a JWT the media plane can verify (spec/media/tokens.md); its jti is the stored row.
   */
  const replaceWhipToken = async (accountId: string, sourceId: string, issue: boolean) => {
    const id = `itk_${randomBytes(9).toString("base64url")}`;
    const token = issue ? await deps.signer.signWhip({ sourceId, jti: id, authorizeUrl: deps.whipAuthorizeUrl! }) : undefined;
    return deps.data.withAccount(accountId, async (s) => {
      await s.db.updateTable("ingest_tokens").set({ revoked_at: new Date() }).where("source_id", "=", sourceId).where("revoked_at", "is", null).execute();
      if (!token) return undefined;
      await s.db.insertInto("ingest_tokens").values({ id, account_id: accountId, source_id: sourceId, token_hash: hashApiKey(token), prefix: token.slice(0, 8) }).execute();
      return token;
    });
  };

  const apiBase = (req: FastifyRequest) => (deps.apiPublicUrl ?? `${req.protocol}://${req.host}`).replace(/\/$/, "");
  /** The one-line install shown for a new bridge; `--rtsp` is a placeholder unless the camera URL is already stored. */
  const dockerCommand = (req: FastifyRequest, token: string, withRtsp: boolean) =>
    `docker run -d --restart unless-stopped --name senseplane-bridge ${deps.bridgeImage ?? "ghcr.io/senseplane-ai/bridge:0.1"} --api ${apiBase(req)} --token ${token}` +
    (withRtsp ? " --rtsp rtsp://USER:PASSWORD@CAMERA-IP:554/stream1" : "");
  /** Issues a fresh token for a bridge, or revokes it (`issue` false). The old token stops working at once. */
  const rotateBridgeToken = async (accountId: string, bridgeId: string, issue: boolean) => {
    const token = newBridgeToken();
    await deps.data.withAccount(accountId, (s) =>
      s.db.updateTable("bridges").set(issue ? { token_hash: hashApiKey(token), prefix: token.slice(0, 8), revoked_at: null } : { revoked_at: new Date() })
        .where("id", "=", bridgeId).execute());
    return token;
  };
  /** Revokes a sensor's integration tokens and, when `issue`, stores a new one. */
  const replaceIntegrationToken = async (accountId: string, sourceId: string, issue: boolean) =>
    deps.data.withAccount(accountId, async (s) => {
      await s.db.updateTable("ingest_tokens").set({ revoked_at: new Date() }).where("source_id", "=", sourceId).where("revoked_at", "is", null).execute();
      if (!issue) return undefined;
      const token = newIntegrationToken();
      await s.db.insertInto("ingest_tokens").values({
        id: `itk_${randomBytes(9).toString("base64url")}`, account_id: accountId, source_id: sourceId, token_hash: hashApiKey(token), prefix: token.slice(0, 8),
      }).execute();
      return token;
    });

  app.post<{ Body: CreateBody }>(
    "/v1/sources",
    { schema: { body: createBody } },
    async (req, reply) => {
      const accountId = req.accountId!;
      const body = req.body;
      const max = await deps.maxRetentionDays(accountId);
      if (body.retention_days && max !== null && body.retention_days > max) {
        throw new ApiError(403, "quota_exceeded", `retention_days is limited to ${max} for this account`, { max });
      }
      if ((body.type === "whip" || body.type === "rtsp") && !whipEnabled()) throw new ApiError(400, "validation_failed", "WHIP ingest is not configured on this deployment");
      if (body.senses && body.type !== "sensor") throw new ApiError(400, "validation_failed", "senses can only be chosen for sensor sources");
      if ((body.rtsp_url || body.bridge_id) && body.type !== "rtsp") throw new ApiError(400, "validation_failed", "rtsp_url and bridge_id are for rtsp sources");
      if (body.bridge_id && !body.rtsp_url) throw new ApiError(400, "validation_failed", "adding a camera to an existing bridge needs its rtsp_url");
      // Bridge cameras are video only: camera audio is usually AAC, which WebRTC can't carry without re-encoding (ADR 0045).
      const recordAudio = body.type !== "sensor" && body.type !== "rtsp" && (body.record_audio ?? false);
      let bridgeToken: string | undefined;
      const source = await deps.data.withAccount(accountId, async (s) => {
        const count = (await s.sources.list()).length;
        const max = await deps.maxSources(accountId);
        if (max !== null && count >= max) {
          throw new ApiError(409, "source_limit_reached", `this account can have at most ${max} sources`, { max_registered_sources: max });
        }
        let bridgeId: string | undefined;
        if (body.type === "rtsp") {
          if (body.bridge_id) {
            const b = await s.db.selectFrom("bridges").select("id").where("id", "=", body.bridge_id).where("revoked_at", "is", null).executeTakeFirst();
            if (!b) throw new ApiError(404, "not_found", "bridge not found");
            bridgeId = b.id;
          } else {
            bridgeToken = newBridgeToken();
            bridgeId = `brg_${randomBytes(9).toString("base64url")}`;
            await s.db.insertInto("bridges").values({
              id: bridgeId, account_id: accountId, name: `Bridge for ${body.name}`.slice(0, 120), token_hash: hashApiKey(bridgeToken), prefix: bridgeToken.slice(0, 8),
            }).execute();
          }
        }
        const created = await s.sources.create({
          name: body.name,
          type: body.type,
          location: body.location,
          senses: body.type === "sensor" ? body.senses ?? [...SENSOR_SENSES] : recordAudio ? ["video", "audio"] : ["video"],
          record_audio: recordAudio,
          retention_days: body.retention_days ?? null,
        });
        if (!bridgeId) return created;
        await s.db.updateTable("sources").set({ bridge_id: bridgeId, rtsp_url: body.rtsp_url ? deps.data.box().encrypt(body.rtsp_url) : null })
          .where("id", "=", created.id).execute();
        return (await s.sources.get(created.id))!;
      });
      await deps.publishConfig?.(accountId, source);
      const shaped = toSource(source, await deps.maxResolution?.(accountId));
      if (body.type === "sensor") {
        // Sensors push readings with a per-source integration token (Home Assistant, scripts).
        const token = (await replaceIntegrationToken(accountId, source.id, true))!;
        return reply.code(201).send({ ...shaped, ingest: { token, integration_token: token, expires_at: null } });
      }
      if (body.type === "rtsp") {
        // Added to an existing bridge: it picks the camera up on its next config poll; no new credential.
        if (!bridgeToken) return reply.code(201).send(shaped);
        return reply.code(201).send({
          ...shaped,
          ingest: { token: bridgeToken, bridge_token: bridgeToken, bridge_id: source.bridge_id, docker_command: dockerCommand(req, bridgeToken, !body.rtsp_url), expires_at: null },
        });
      }
      if (body.type === "whip") {
        const token = (await replaceWhipToken(accountId, source.id, true))!;
        return reply.code(201).send({
          ...toSource(source, await deps.maxResolution?.(accountId)),
          ingest: { whip_url: whipUrl(source.id), token, expires_at: null },
        });
      }
      return reply.code(201).send({
        ...toSource(source, await deps.maxResolution?.(accountId)),
        ingest: await captureLink(req, accountId, source, 0),
      });
    },
  );

  /** A capture link for the source's current epoch. The ticket rides in the fragment, so it never reaches server logs. */
  const captureLink = async (req: FastifyRequest, accountId: string, source: Source, epoch: number) => {
    const { token, expiresAt } = await deps.signer.signTicket({ accountId, sourceId: source.id, recordAudio: source.record_audio, epoch }, deps.ticketTtlSeconds);
    const api = deps.apiPublicUrl ?? `${req.protocol}://${req.host}`;
    const fragment = new URLSearchParams({ t: token, a: api, n: source.name });
    return { capture_url: `${deps.captureUrl}#${fragment.toString()}`, token, expires_at: expiresAt.toISOString() };
  };

  // Rotate: invalidates every earlier capture link and unbinds the device (ADR 0038). Owner keys only.
  app.post<{ Params: { id: string } }>("/v1/sources/:id/capture-link", async (req, reply) => {
    const accountId = req.accountId!;
    const row = await deps.data.withAccount(accountId, async (s) => {
      const src = await s.sources.get(req.params.id);
      if (!src || src.type !== "browser") throw new ApiError(404, "not_found", "source not found");
      return s.db.updateTable("sources")
        .set((eb) => ({ capture_epoch: eb("capture_epoch", "+", 1), capture_device_hash: null, capture_bound_at: null }))
        .where("id", "=", src.id).returning(["capture_epoch"]).executeTakeFirstOrThrow();
    });
    const source = (await deps.data.withAccount(accountId, (s) => s.sources.get(req.params.id)))!;
    return reply.code(201).send({ ...toSource(source, await deps.maxResolution?.(accountId)), ingest: await captureLink(req, accountId, source, row.capture_epoch) });
  });

  // Authenticated by the capture ticket (not an API key): see ADR 0017.
  app.post<{ Body: { ticket: string; device?: string } }>(
    "/v1/capture/join",
    {
      schema: {
        body: {
          type: "object", additionalProperties: false, required: ["ticket"],
          properties: { ticket: { type: "string", minLength: 10 }, device: { type: "string", minLength: 16, maxLength: 128 } },
        },
      },
    },
    async (req) => {
      let ticket;
      try {
        ticket = await deps.signer.verifyTicket(req.body.ticket);
      } catch {
        throw new ApiError(401, "unauthorized", "capture link is invalid or expired");
      }
      const source = await deps.data.withAccount(ticket.accountId, (s) => s.sources.get(ticket.sourceId));
      if (!source) throw new ApiError(404, "not_found", "source not found");
      refusePaused(source);
      await bindDevice(ticket.accountId, source, ticket, req.body.device);
      await deps.audit?.write({ accountId: ticket.accountId, actor: "capture", action: "capture.join", target: source.id, status: 200, details: { ip: req.ip } });
      const maxResolution = (await deps.maxResolution?.(ticket.accountId)) ?? "720p";
      if (await deps.ingestBlocked?.(ticket.accountId)) throw new ApiError(429, "allowance_exhausted", "This account has used its camera time for now.");
      const maxActive = (await deps.maxActiveSources?.(ticket.accountId)) ?? null;
      if (maxActive !== null) {
        const streaming = await deps.data.withAccount(ticket.accountId, async (s) => (await s.sources.list()).filter((x) => x.status === "online" && x.id !== ticket.sourceId).length);
        if (streaming >= maxActive) {
          throw new ApiError(409, "source_limit_reached", "This account's camera limit is reached: stop another camera first.", { max_active_sources: maxActive });
        }
      }
      // The camera's room and feed exist before the token does (ADR 0049).
      const { signalUrl } = await deps.media.prepareCamera(ticket.accountId, source, { maxResolution });
      const { token, expiresAt } = await deps.signer.signJoin(
        { accountId: ticket.accountId, sourceId: source.id, recordAudio: source.record_audio, name: source.name, maxResolution, maxActiveSources: maxActive ?? undefined },
        deps.joinTtlSeconds,
      );
      return { token, url: signalUrl, expires_at: expiresAt.toISOString(), max_resolution: maxResolution };
    },
  );

  // --- Ingest tokens: WHIP (ADR 0034), bridges and sensor integrations (ADR 0045) ---
  const tokenSource = async (accountId: string, id: string) => {
    const source = await deps.data.withAccount(accountId, (s) => s.sources.get(id));
    if (!source) throw new ApiError(404, "not_found", "source not found");
    if (!["whip", "rtsp", "sensor"].includes(source.type)) throw new ApiError(400, "validation_failed", "only whip, rtsp and sensor sources have an ingest token");
    if (source.type !== "sensor" && !whipEnabled()) throw new ApiError(400, "validation_failed", "WHIP ingest is not configured on this deployment");
    if (source.type === "rtsp" && !source.bridge_id) throw new ApiError(400, "validation_failed", "this camera is not on a bridge");
    return source;
  };
  /** Cuts off every camera a bridge carries (their pushes used the old token). */
  const disconnectBridge = async (accountId: string, bridgeId: string) => {
    const ids = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("sources").select("id").where("bridge_id", "=", bridgeId).execute());
    for (const { id } of ids) await deps.media.disconnect?.(id);
  };
  app.post<{ Params: { id: string } }>("/v1/sources/:id/ingest-token", async (req) => {
    const source = await tokenSource(req.accountId!, req.params.id);
    if (source.type === "sensor") {
      const token = (await replaceIntegrationToken(req.accountId!, source.id, true))!;
      return { token, integration_token: token };
    }
    if (source.type === "rtsp") {
      // The token belongs to the bridge, so rotating it re-keys every camera on that bridge.
      const token = await rotateBridgeToken(req.accountId!, source.bridge_id!, true);
      await disconnectBridge(req.accountId!, source.bridge_id!);
      return { token, bridge_token: token, bridge_id: source.bridge_id, docker_command: dockerCommand(req, token, false) };
    }
    const token = (await replaceWhipToken(req.accountId!, source.id, true))!;
    await deps.media.disconnect?.(source.id); // a publisher using the old token is cut off now
    return { whip_url: whipUrl(source.id), token };
  });
  app.delete<{ Params: { id: string } }>("/v1/sources/:id/ingest-token", async (req, reply) => {
    const source = await tokenSource(req.accountId!, req.params.id);
    if (source.type === "sensor") {
      await replaceIntegrationToken(req.accountId!, source.id, false);
      return reply.code(204).send();
    }
    if (source.type === "rtsp") {
      await rotateBridgeToken(req.accountId!, source.bridge_id!, false);
      await disconnectBridge(req.accountId!, source.bridge_id!);
      return reply.code(204).send();
    }
    await replaceWhipToken(req.accountId!, source.id, false);
    await deps.media.disconnect?.(source.id);
    return reply.code(204).send();
  });

  // Pause and resume (ADR 0045 addendum): a paused camera records and analyses
  // nothing. Its live session is ended, and new pushes (WHIP, bridge, capture
  // link) are refused with 409 until it is resumed; bridges drop it from their
  // config. Pausing is a camera's state, not a sensor's.
  const setPaused = async (req: FastifyRequest<{ Params: { id: string } }>, paused: boolean) => {
    const accountId = req.accountId!;
    const row = await deps.data.withAccount(accountId, async (s) => {
      const src = await s.sources.get(req.params.id);
      if (!src) throw new ApiError(404, "not_found", "source not found");
      if (src.type === "sensor") throw new ApiError(409, "conflict", "A sensor can't be paused; revoke its integration token to stop readings.", { reason: "sensor" });
      if ((src.status === "paused") === paused) return src;
      return s.db.updateTable("sources").set({ status: paused ? "paused" : "offline" }).where("id", "=", src.id).returningAll().executeTakeFirstOrThrow();
    });
    if (paused) {
      await deps.media.disconnect?.(row.id, "paused");
      await deps.media.stopFeed?.(accountId, row.id, "paused");
    }
    await deps.audit?.write({ accountId, actor: req.access?.userId ? `user:${req.access.userId}` : "api", action: paused ? "source.paused" : "source.resumed", target: row.id, status: 200 });
    return toSource(row, await deps.maxResolution?.(accountId));
  };
  app.post<{ Params: { id: string } }>("/v1/sources/:id/pause", (req) => setPaused(req, true));
  app.post<{ Params: { id: string } }>("/v1/sources/:id/resume", (req) => setPaused(req, false));

  /**
   * The WHIP bearer's authorize_url (spec/media/whip.md): called by the media
   * plane's WHIP ingress with the bearer itself as the credential. The bearer
   * names its room and a jti: a WHIP source's stored credential, or a bridge
   * camera's (`bridge:<bridge id>:<hash prefix>`, retired when the bridge token
   * is rotated). Answers a 10-minute join token for that room.
   */
  app.post<{ Body: { room?: string; jti?: string; remote_address?: string } }>(
    "/internal/media/whip-authorize",
    { schema: { body: { type: "object", properties: { room: { type: "string", maxLength: 200 }, jti: { type: "string", maxLength: 200 }, remote_address: { type: "string", maxLength: 100 } } } } },
    async (req) => {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "").trim();
      let claim: { sourceId: string; jti: string };
      try {
        claim = await deps.signer.verifyWhip(bearer);
      } catch {
        throw new ApiError(401, "unauthorized", "unknown or invalid WHIP bearer");
      }
      const sourceId = claim.sourceId;
      if (req.body?.room !== undefined && req.body.room !== roomFor(sourceId)) throw new ApiError(401, "unauthorized", "unknown or invalid WHIP bearer");
      let accountId: string | undefined;
      let bridgeId: string | undefined;
      const bridged = /^bridge:([^:]+):([0-9a-f]{16,})$/.exec(claim.jti);
      if (bridged) {
        bridgeId = bridged[1]!;
        accountId = await deps.data.authenticateBridgeWhip(bridgeId, bridged[2]!);
      } else {
        accountId = await deps.data.authenticateIngestToken(bearer, sourceId);
      }
      if (!accountId) throw new ApiError(401, "unauthorized", "unknown or revoked WHIP token");
      const source = await deps.data.withAccount(accountId, (s) => s.sources.get(sourceId));
      if (!source) throw new ApiError(401, "unauthorized", "unknown or revoked WHIP token");
      if (bridgeId && (source.type !== "rtsp" || source.bridge_id !== bridgeId)) throw new ApiError(401, "unauthorized", "unknown or revoked WHIP token");
      const audit = (status: number) =>
        deps.audit?.write({ accountId: accountId!, actor: bridgeId ? `bridge:${bridgeId}` : `whip:${claim.jti.slice(0, 12)}`, action: "WHIP connect", target: sourceId, status,
          ...(req.body?.remote_address ? { details: { ip: req.body.remote_address } } : {}) }).catch(() => undefined);
      if (source.status === "paused") await audit(409);
      refusePaused(source);
      if (await deps.ingestBlocked?.(accountId)) {
        await audit(429);
        throw new ApiError(429, "quota_exceeded", "This account has used its recording allowance for now.");
      }
      const maxActive = (await deps.maxActiveSources?.(accountId)) ?? null;
      if (maxActive !== null) {
        const streaming = await deps.data.withAccount(accountId!, async (s) => (await s.sources.list()).filter((x) => x.status === "online" && x.id !== sourceId).length);
        if (streaming >= maxActive) {
          await audit(409);
          throw new ApiError(409, "source_limit_reached", "This account's camera limit is reached: stop another camera first.", { max_active_sources: maxActive });
        }
      }
      const maxResolution = (await deps.maxResolution?.(accountId)) ?? "720p";
      const { signalUrl } = await deps.media.prepareCamera(accountId, source, { maxResolution });
      const { token } = await deps.signer.signJoin(
        { accountId, sourceId, recordAudio: source.record_audio, name: source.name, maxResolution, maxActiveSources: maxActive ?? undefined, via: "whip" },
        deps.joinTtlSeconds,
      );
      await audit(200);
      return { token, mediaUrl: signalUrl, max_resolution: maxResolution };
    },
  );

  app.get("/v1/sources", async (req) => {
    const rows = (await deps.data.withAccount(req.accountId!, (s) => s.sources.list())).filter((r) => seesSource(req, r.id));
    const res = await deps.maxResolution?.(req.accountId!);
    return { data: rows.map((r) => grantedView(req, toSource(r, res))), next_cursor: null };
  });

  app.get<{ Params: { id: string } }>("/v1/sources/:id", async (req) => {
    const row = await deps.data.withAccount(req.accountId!, (s) => s.sources.get(req.params.id));
    if (!row) throw new ApiError(404, "not_found", "source not found");
    return grantedView(req, toSource(row, await deps.maxResolution?.(req.accountId!)));
  });
}
