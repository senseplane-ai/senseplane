// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Everything the media plane sends back (spec/media/callbacks.json), at
// POST /internal/media/callbacks. The bearer is the callback token the API
// minted for the room or the feed (ADR 0049); the account and source come
// from it, never from the body. Answers 2xx only once the event is stored, so
// the media plane retries anything that failed; every handler is idempotent.
import { SpanKind, contextFromTraceparent, withSpan } from "@senseplane/telemetry";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { DataAccess } from "../data/access.js";
import { ApiError } from "../errors.js";
import { type FramesMeta, type MaskCache, forwardFrames } from "../frames.js";
import { handleMediaEvent } from "../indexer.js";
import { type CallbackClaims, type IngestSigner, roomFor } from "../ingest.js";
import { CAMERA_IDENTITIES, type MediaControl, isViewer, viewerSession } from "../media-driver.js";
import type { ObjectStorage } from "../storage.js";
import { handleViewerEvent } from "./live.js";

export interface CallbackDeps {
  data: DataAccess;
  signer: IngestSigner;
  storage?: ObjectStorage;
  media?: MediaControl;
  masks: MaskCache;
  /** Sends one frame or audio chunk to the camera's brain; false when no brain is alive. */
  publishMedia?(accountId: string, sourceId: string, kind: "frame" | "audio", meta: Record<string, unknown>, data: Buffer): Promise<boolean>;
  /** The camera went offline: let its brain go. */
  releaseCamera?(accountId: string, sourceId: string): Promise<void>;
  /** A feed ended on the media plane (restart it if the camera is still on). */
  onFeedEnded?(accountId: string, sourceId: string, sessionId: string): Promise<void>;
  log: FastifyBaseLogger;
}

const FEED_EVENTS = new Set(["source.online", "source.offline", "segment.written", "recording.gap", "resolution_rejected"]);
const UPLOAD_TYPES = new Set(["video/mp4", "video/iso.segment"]);

export function registerMediaCallbacks(app: FastifyInstance, deps: CallbackDeps) {
  app.register(async (scope) => {
    // Frames batches: ≤ 5 JPEGs + 1 s of audio, about 200 KB.
    scope.addContentTypeParser("multipart/form-data", { parseAs: "buffer", bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    scope.post("/internal/media/callbacks", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
      const h = req.headers.authorization ?? "";
      let claims: CallbackClaims;
      try {
        claims = await deps.signer.verifyCallback(h.startsWith("Bearer ") ? h.slice(7).trim() : "");
      } catch {
        throw new ApiError(401, "unauthorized", "a valid media callback token is required");
      }
      const { accountId, sourceId } = claims;
      const ct = String(req.headers["content-type"] ?? "");
      // A callback the media plane traced (a sampled frames batch, a segment upload) continues its trace here;
      // frames forwarded inside it carry it on to the brain.
      const tp = typeof req.headers.traceparent === "string" ? req.headers.traceparent : undefined;
      const traced = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
        tp ? withSpan(name, { kind: SpanKind.CONSUMER, parent: contextFromTraceparent(tp), attributes: { "senseplane.source_id": sourceId } }, fn) : fn();

      if (ct.startsWith("multipart/form-data")) {
        if (claims.kind !== "feed") throw new ApiError(403, "forbidden", "frames come from a feed");
        const form = await new Request("http://callback/", { method: "POST", headers: { "content-type": ct }, body: new Uint8Array(req.body as Buffer) }).formData();
        const metaPart = form.get("meta");
        const meta = metaPart instanceof Blob ? (JSON.parse(await metaPart.text()) as { sessionId?: string; data?: FramesMeta }) : undefined;
        if (!meta?.data) throw new ApiError(400, "validation_failed", "a frames batch needs its meta part");
        if (claims.sessionId && meta.sessionId !== claims.sessionId) throw new ApiError(403, "forbidden", "this token is for another feed");
        if (!deps.publishMedia) return reply.code(202).send({ ok: true, forwarded: 0 });
        const mask = await deps.masks.get(accountId, sourceId);
        const out = await traced("consume media.frames", () => forwardFrames(form, meta.data!, mask, (kind, m, data) => deps.publishMedia!(accountId, sourceId, kind, m, data)));
        return { ok: true, forwarded: out.frames };
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      // Requests: a presigned PUT for one object of this camera, under its own prefix only.
      if (typeof body.op === "string") {
        if (claims.kind !== "feed") throw new ApiError(403, "forbidden", "uploads come from a feed");
        if (body.op !== "upload_url") throw new ApiError(400, "validation_failed", `op ${body.op} is not offered: this API presigns each object`);
        const key = String(body.key ?? "");
        const prefix = `raw/${accountId}/${sourceId}/`;
        if (!key.startsWith(prefix) || key.split("/").includes("..")) throw new ApiError(403, "forbidden", "that key is outside this camera's prefix");
        const type = String(body.content_type ?? "");
        if (!UPLOAD_TYPES.has(type)) throw new ApiError(400, "validation_failed", "content_type must be video/mp4 or video/iso.segment");
        if (!deps.storage) throw new ApiError(503, "service_unavailable", "object storage is not configured");
        return { url: await deps.storage.presignPut(key, type, 120) };
      }

      const event = String(body.event ?? "");
      const at = typeof body.at === "string" ? new Date(body.at) : new Date();
      // Room callbacks: viewers joining and leaving (live view), the room ending.
      if (typeof body.roomId === "string") {
        if (body.roomId !== roomFor(sourceId)) throw new ApiError(403, "forbidden", "this token is for another room");
        const d = (body.data ?? {}) as { identity?: string; reason?: string };
        if ((event === "participant.joined" || event === "participant.left") && d.identity && isViewer(d.identity)) {
          const sid = viewerSession(d.identity);
          if (sid) await handleViewerEvent(deps.data, accountId, event === "participant.joined" ? "joined" : "left", sid, at, d.reason);
        } else if (event === "participant.left" && d.identity && CAMERA_IDENTITIES(sourceId).includes(d.identity) && d.reason !== "replaced") {
          // The camera left the room: offline now, on any media plane (its feed says so too, a moment later).
          // A newer status (the camera back already) is never overridden.
          await handleMediaEvent(deps.data, "media.source.offline", { account_id: accountId, source_id: sourceId, at: at.toISOString() }, deps.log);
        } else if (event === "egress.failed" && typeof body.sessionId === "string") {
          await deps.onFeedEnded?.(accountId, sourceId, body.sessionId);
        }
        return { ok: true };
      }
      if (event === "egress.session.ended") {
        const session = (body.session ?? {}) as { sessionId?: string };
        if (session.sessionId) await deps.onFeedEnded?.(accountId, sourceId, session.sessionId);
        return { ok: true };
      }
      if (FEED_EVENTS.has(event)) {
        if (claims.kind !== "feed") throw new ApiError(403, "forbidden", "feed events come from a feed");
        if (claims.sessionId && body.sessionId !== claims.sessionId) throw new ApiError(403, "forbidden", "this token is for another feed");
        const data = { ...((body.data ?? {}) as Record<string, unknown>), account_id: accountId, source_id: sourceId };
        await traced(`consume media.${event}`, () => handleMediaEvent(deps.data, `media.${event}`, data, deps.log));
        if (event === "source.offline") await deps.releaseCamera?.(accountId, sourceId);
        if (event === "resolution_rejected") {
          // Above the account's resolution limit: nothing was stored; the camera is told why, once (ADR 0022).
          await deps.media?.disconnect?.(sourceId, "resolution_not_in_plan");
          await deps.data.withAccount(accountId, (s) => s.sources.setStatus(sourceId, "offline"));
        }
        return { ok: true };
      }
      deps.log.warn({ event }, "unknown media callback ignored");
      return reply.code(202).send({ ok: true });
    });
  });
}
