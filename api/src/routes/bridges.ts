// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The bridge's side of the API (ADR 0045), authenticated by a bridge token
// (`brg_…`), never by an API key:
// - GET  /v1/bridge/config   the cameras assigned to this bridge, with their
//                            RTSP URLs (decrypted) and WHIP push targets
// - POST /v1/bridge/cameras  claim or add a camera by RTSP URL (`--rtsp`)
// - POST /v1/bridge/health   heartbeat and per-camera state
// Plus GET /v1/integration for a sensor integration token (`sit_…`).
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { DataAccess, Source } from "../data/access.js";
import { ApiError } from "../errors.js";
import type { IngestSigner } from "../ingest.js";
import type { AuditLog } from "../module.js";
import { redactUrls, toSource } from "./sources.js";

export const BRIDGE_HEARTBEAT_SECONDS = 30;
export const BRIDGE_POLL_SECONDS = 60;
/** A bridge silent for this long has its cameras marked offline. */
export const BRIDGE_SILENT_SECONDS = 3 * BRIDGE_HEARTBEAT_SECONDS;

declare module "fastify" {
  interface FastifyRequest {
    bridge?: { bridgeId: string; accountId: string };
  }
}

export interface BridgeDeps {
  data: DataAccess;
  /** The media plane's public base (WHIP URLs) and where a camera's WHIP bearer is authorised. */
  whip?: { publicUrl: string; authorizeUrl: string; signer: IngestSigner };
  maxSources(accountId: string): Promise<number | null>;
  audit?: AuditLog;
}

const healthBody = {
  type: "object", additionalProperties: false, required: ["cameras"],
  properties: {
    version: { type: "string", maxLength: 64 },
    cameras: {
      type: "array", maxItems: 256,
      items: {
        type: "object", additionalProperties: false, required: ["source_id", "state"],
        properties: {
          source_id: { type: "string", maxLength: 64 },
          state: { enum: ["connecting", "online", "reconnecting", "offline"] },
          detail: { type: "string", maxLength: 500 },
        },
      },
    },
  },
} as const;

type CameraState = "connecting" | "online" | "reconnecting" | "offline";

/** The source status a bridge report implies; undefined leaves it to the media plane. */
function statusFor(state: CameraState): string | undefined {
  if (state === "reconnecting") return "reconnecting";
  if (state === "offline") return "offline";
  if (state === "online") return "online";
  return undefined;
}

export function registerBridgeRoutes(app: FastifyInstance, deps: BridgeDeps) {
  const whipUrl = (sourceId: string) => `${deps.whip!.publicUrl.replace(/\/$/, "")}/whip/${encodeURIComponent(sourceId)}`;
  const box = () => deps.data.box();

  app.register(async (scope) => {
    scope.addHook("onRequest", async (req) => {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const bridge = token.startsWith("brg_") ? await deps.data.authenticateBridgeToken(token) : undefined;
      if (!bridge) throw new ApiError(401, "unauthorized", "a valid bridge token is required");
      if (!deps.whip) throw new ApiError(503, "service_unavailable", "WHIP ingest is not configured on this deployment");
      req.bridge = bridge;
    });

    const cameras = (req: FastifyRequest) =>
      deps.data.withAccount(req.bridge!.accountId, (s) =>
        s.db.selectFrom("sources").selectAll().where("bridge_id", "=", req.bridge!.bridgeId).where("type", "=", "rtsp").orderBy("created_at").execute());
    /** The bridge's current token, by hash prefix: a camera's WHIP bearer names it, so rotating the token retires them. */
    const tokenPrefix = async (req: FastifyRequest) =>
      (await deps.data.withAccount(req.bridge!.accountId, (s) => s.db.selectFrom("bridges").select("token_hash").where("id", "=", req.bridge!.bridgeId).executeTakeFirstOrThrow())).token_hash.slice(0, 16);
    const toCamera = async (req: FastifyRequest, src: Source) => ({
      source_id: src.id, name: src.name, rtsp_url: box().decrypt(src.rtsp_url!), whip_url: whipUrl(src.id),
      // A WHIP bearer per camera (spec/media/whip.md); the bridge pushes with it.
      whip_token: await deps.whip!.signer.signWhip({ sourceId: src.id, jti: `bridge:${req.bridge!.bridgeId}:${await tokenPrefix(req)}`, authorizeUrl: deps.whip!.authorizeUrl }),
    });

    scope.get("/v1/bridge/config", async (req) => {
      const { bridgeId, accountId } = req.bridge!;
      const bridge = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("bridges").select(["id", "name"]).where("id", "=", bridgeId).executeTakeFirstOrThrow());
      return {
        bridge_id: bridge.id,
        name: bridge.name,
        heartbeat_seconds: BRIDGE_HEARTBEAT_SECONDS,
        poll_seconds: BRIDGE_POLL_SECONDS,
        // Cameras without an RTSP URL wait for `--rtsp` (or a PATCH) before the bridge can pull them.
        // Paused cameras are left out, so the bridge stops pulling them until they are resumed.
        cameras: await Promise.all((await cameras(req)).filter((c) => c.rtsp_url && c.status !== "paused").map((c) => toCamera(req, c))),
      };
    });

    // `--rtsp URL`: the same URL again is a no-op; otherwise the oldest camera still waiting
    // for a URL takes it; otherwise a new camera is added to this bridge.
    scope.post<{ Body: { rtsp_url: string; name?: string } }>(
      "/v1/bridge/cameras",
      { schema: { body: { type: "object", additionalProperties: false, required: ["rtsp_url"], properties: { rtsp_url: { type: "string", maxLength: 2048, pattern: "^rtsps?://" }, name: { type: "string", minLength: 1, maxLength: 120 } } } } },
      async (req, reply) => {
        const { bridgeId, accountId } = req.bridge!;
        const all = await cameras(req);
        const same = all.find((c) => c.rtsp_url && box().decrypt(c.rtsp_url) === req.body.rtsp_url);
        if (same) return toCamera(req, same);
        const waiting = all.find((c) => !c.rtsp_url);
        const enc = box().encrypt(req.body.rtsp_url);
        let src: Source;
        let created = false;
        if (waiting) {
          src = await deps.data.withAccount(accountId, async (s) => {
            await s.db.updateTable("sources").set({ rtsp_url: enc, ...(req.body.name ? { name: req.body.name } : {}) }).where("id", "=", waiting.id).execute();
            return (await s.sources.get(waiting.id))!;
          });
        } else {
          const max = await deps.maxSources(accountId);
          src = await deps.data.withAccount(accountId, async (s) => {
            if (max !== null && (await s.sources.list()).length >= max) {
              throw new ApiError(409, "source_limit_reached", `this account can have at most ${max} sources`, { max_registered_sources: max });
            }
            const host = (() => {
              try {
                return new URL(req.body.rtsp_url.replace(/^rtsps?:/, "http:")).hostname;
              } catch {
                return "camera";
              }
            })();
            const row = await s.sources.create({ name: req.body.name ?? `Camera ${host}`, type: "rtsp", senses: ["video"], record_audio: false });
            await s.db.updateTable("sources").set({ bridge_id: bridgeId, rtsp_url: enc }).where("id", "=", row.id).execute();
            return (await s.sources.get(row.id))!;
          });
          created = true;
        }
        await deps.audit?.write({ accountId, actor: `bridge:${bridgeId}`, action: created ? "bridge.camera_added" : "bridge.camera_claimed", target: src.id, status: created ? 201 : 200 });
        return reply.code(created ? 201 : 200).send(await toCamera(req, src));
      },
    );

    scope.post<{ Body: { version?: string; cameras: { source_id: string; state: CameraState; detail?: string }[] } }>(
      "/v1/bridge/health",
      { schema: { body: healthBody } },
      async (req, reply) => {
        const { bridgeId, accountId } = req.bridge!;
        await deps.data.withAccount(accountId, async (s) => {
          await s.db.updateTable("bridges").set({ last_seen_at: new Date(), version: req.body.version ?? null }).where("id", "=", bridgeId).execute();
          for (const c of req.body.cameras) {
            const status = statusFor(c.state);
            // Only this bridge's cameras; the row filter makes a foreign id a no-op.
            await s.db.updateTable("sources")
              .set((eb) => ({
                bridge_state: c.state, bridge_detail: c.detail ? redactUrls(c.detail).slice(0, 500) : null,
                ...(status ? { status: eb.case().when("status", "=", "paused").then("paused").else(status).end() } : {}),
              }))
              .where("id", "=", c.source_id).where("bridge_id", "=", bridgeId).execute();
          }
        });
        return reply.code(204).send();
      },
    );
  });

  // A sensor integration token learns which source it feeds (Home Assistant's config flow).
  app.get("/v1/integration", async (req) => {
    const sourceId = req.access?.integrationSource;
    if (!sourceId) throw new ApiError(403, "forbidden", "this endpoint takes a sensor integration token");
    const src = await deps.data.withAccount(req.accountId!, (s) => s.sources.get(sourceId));
    if (!src) throw new ApiError(404, "not_found", "source not found");
    return { source: toSource(src) };
  });
}

/** Marks the cameras of bridges that stopped reporting as offline (called by the API's periodic loop). */
export async function markSilentBridges(data: DataAccess, log?: FastifyBaseLogger) {
  const silent = await data.silentBridges(BRIDGE_SILENT_SECONDS);
  for (const b of silent) {
    await data.withAccount(b.account_id, (s) =>
      s.db.updateTable("sources")
        .set((eb) => ({ bridge_state: "offline", bridge_detail: "the bridge stopped reporting", status: eb.case().when("status", "in", ["online", "paused"]).then(eb.ref("status")).else("offline").end() }))
        .where("bridge_id", "=", b.bridge_id).execute());
    log?.info({ bridge: b.bridge_id }, "bridge stopped reporting; cameras marked offline");
  }
  return silent.length;
}
