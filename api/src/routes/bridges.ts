// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The bridge's side of the API (ADR 0045), authenticated by a bridge token
// (`brg_…`), never by an API key:
// - GET  /v1/bridge/config   the cameras assigned to this bridge, with their
//                            RTSP URLs (decrypted) and WHIP push targets
// - POST /v1/bridge/cameras  claim or add a camera by RTSP URL (`--rtsp`)
// - POST /v1/bridge/health   heartbeat and per-camera state
// - PUT  /v1/bridge/entities the Home Assistant entities it can send (ADR 0061)
// - POST /v1/bridge/readings readings of the entities a person chose
// - PUT  /v1/bridge/cameras-found  the cameras it found to pick from (ADR 0063)
// Plus GET /v1/integration for a sensor integration token (`sit_…`), and the
// console's side: POST/GET /v1/bridges and choosing a bridge's entities.
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type { AccountScope, DataAccess, Source } from "../data/access.js";
import { hashApiKey } from "../data/access.js";
import { ApiError } from "../errors.js";
import type { IngestSigner } from "../ingest.js";
import type { AuditLog } from "../module.js";
import { type ReadingInput, cleanReading, readingInputSchema } from "../readings.js";
import { ingestReadings } from "./source-config.js";
import { newBridgeToken, redactUrls, toSource } from "./sources.js";

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
  /** The plan's largest stream, for a box that picks a camera's stream itself (a phone, ADR 0064). */
  maxResolution?(accountId: string): Promise<"720p" | "1080p">;
  audit?: AuditLog;
}

const healthBody = {
  type: "object", additionalProperties: false, required: ["cameras"],
  properties: {
    version: { type: "string", maxLength: 64 },
    home_assistant: {
      type: "object", additionalProperties: false, required: ["connected"],
      properties: { connected: { type: "boolean" }, entities: { type: "integer", minimum: 0 }, sending: { type: "integer", minimum: 0 } },
    },
    matter: {
      type: "object", additionalProperties: false, required: ["connected"],
      properties: { connected: { type: "boolean" }, nodes: { type: "integer", minimum: 0 } },
    },
    cameras_found: { type: "integer", minimum: 0 },
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

interface FoundListed {
  id: string; address?: string; xaddr?: string; manufacturer?: string; model?: string; name?: string; onvif: boolean;
  home_assistant?: { entity_id: string; name: string; area?: string };
}
const foundListedSchema = {
  type: "object", additionalProperties: false, required: ["id", "onvif"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 200 }, address: { type: "string", maxLength: 255 },
    xaddr: { type: "string", maxLength: 512, pattern: "^https?://" },
    manufacturer: { type: "string", maxLength: 120 }, model: { type: "string", maxLength: 120 }, name: { type: "string", maxLength: 120 },
    onvif: { type: "boolean" },
    home_assistant: {
      type: "object", additionalProperties: false, required: ["entity_id", "name"],
      properties: { entity_id: { type: "string", maxLength: 200, pattern: "^camera\\.[a-z0-9_]+$" }, name: { type: "string", maxLength: 200 }, area: { type: "string", maxLength: 120 } },
    },
  },
} as const;

/** The host of an RTSP URL (lowercase), or undefined. */
function rtspHost(url: string): string | undefined {
  try {
    return new URL(url.replace(/^rtsps?:/i, "http:")).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** The source status a bridge report implies; undefined leaves it to the media plane. */
function statusFor(state: CameraState): string | undefined {
  if (state === "reconnecting") return "reconnecting";
  if (state === "offline") return "offline";
  if (state === "online") return "online";
  return undefined;
}

/** Extends the box's current span of reading Home Assistant, or starts one after a gap of three heartbeats. */
async function extendLink(s: AccountScope, accountId: string, bridgeId: string, now: Date) {
  const cur = await s.db.selectFrom("bridge_links").select("id").where("bridge_id", "=", bridgeId)
    .where("ended_at", ">=", new Date(now.getTime() - BRIDGE_SILENT_SECONDS * 1000)).orderBy("ended_at", "desc").limit(1).executeTakeFirst();
  if (cur) await s.db.updateTable("bridge_links").set({ ended_at: now }).where("id", "=", cur.id).execute();
  else await s.db.insertInto("bridge_links").values({ account_id: accountId, bridge_id: bridgeId, started_at: now, ended_at: now }).execute();
}

/** When a box could read Home Assistant within [from, to); a span still being extended runs to `now`. */
export async function linkedRanges(s: AccountScope, bridgeId: string, from: number, to: number, now = Date.now()): Promise<[number, number][]> {
  const rows = await s.db.selectFrom("bridge_links").select(["started_at", "ended_at"]).where("bridge_id", "=", bridgeId)
    .where("started_at", "<", new Date(to)).where("ended_at", ">=", new Date(from - BRIDGE_SILENT_SECONDS * 1000)).orderBy("started_at").execute();
  return rows.map((r) => {
    const end = new Date(r.ended_at).getTime();
    // Reports come every 30 s: a span is good until the next one is due.
    const until = now - end < BRIDGE_SILENT_SECONDS * 1000 ? now : end + BRIDGE_HEARTBEAT_SECONDS * 1000;
    return [Math.max(from, new Date(r.started_at).getTime()), Math.min(to, until)] as [number, number];
  }).filter(([a, b]) => b > a);
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
      req.bridge = bridge;
    });
    /** Cameras need WHIP; sensors don't. */
    const needWhip = () => {
      if (!deps.whip) throw new ApiError(503, "service_unavailable", "WHIP ingest is not configured on this deployment");
    };

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
        cameras: deps.whip ? await Promise.all((await cameras(req)).filter((c) => c.rtsp_url && c.status !== "paused").map((c) => toCamera(req, c))) : [],
        max_resolution: deps.maxResolution ? await deps.maxResolution(accountId) : "720p",
        // The Home Assistant entities a person chose; the bridge sends nothing else (ADR 0061).
        sensors: (await deps.data.withAccount(accountId, (s) => s.db.selectFrom("bridge_entities").select("entity_id").where("bridge_id", "=", bridgeId)
          .where("source_id", "is not", null).where("listed", "=", true).orderBy("entity_id").execute())).map((e) => e.entity_id),
      };
    });

    // `--rtsp URL`: the same URL again is a no-op; otherwise the oldest camera still waiting
    // for a URL takes it; otherwise a new camera is added to this bridge.
    scope.post<{ Body: { rtsp_url: string; name?: string } }>(
      "/v1/bridge/cameras",
      { schema: { body: { type: "object", additionalProperties: false, required: ["rtsp_url"], properties: { rtsp_url: { type: "string", maxLength: 2048, pattern: "^rtsps?://" }, name: { type: "string", minLength: 1, maxLength: 120 } } } } },
      async (req, reply) => {
        needWhip();
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

    scope.post<{ Body: { version?: string; cameras: { source_id: string; state: CameraState; detail?: string }[]; home_assistant?: { connected: boolean; entities?: number; sending?: number }; matter?: { connected: boolean; nodes?: number }; cameras_found?: number } }>(
      "/v1/bridge/health",
      { schema: { body: healthBody } },
      async (req, reply) => {
        const { bridgeId, accountId } = req.bridge!;
        const ha = req.body.home_assistant;
        await deps.data.withAccount(accountId, async (s) => {
          const now = new Date();
          await s.db.updateTable("bridges").set({
            last_seen_at: now, version: req.body.version ?? null,
            home_connected: ha ? ha.connected : null, home_entities: ha?.entities ?? null, home_sending: ha?.sending ?? null,
            matter_connected: req.body.matter ? req.body.matter.connected : null, matter_nodes: req.body.matter?.nodes ?? null,
            cameras_found: req.body.cameras_found ?? null,
          }).where("id", "=", bridgeId).execute();
          if (ha) {
            // The box's sensors are online while it reads Home Assistant; otherwise their latest values are old news.
            await s.db.updateTable("sources").set((eb) => ({
              bridge_state: ha.connected ? "online" : "offline", bridge_detail: ha.connected ? null : "the box can't reach Home Assistant",
              status: eb.case().when("status", "=", "paused").then("paused").else(ha.connected ? "online" : "offline").end(),
            })).where("bridge_id", "=", bridgeId).where("type", "=", "sensor").execute();
            if (ha.connected) await extendLink(s, accountId, bridgeId, now);
          }
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

    // The entities the bridge's Home Assistant has that Senseplane can take; ones it no longer lists stay, marked unlisted.
    scope.put<{ Body: { entities: { entity_id: string; name: string; area?: string; device_class?: string; sense: string; kind: string }[] } }>(
      "/v1/bridge/entities",
      { schema: { body: { type: "object", additionalProperties: false, required: ["entities"], properties: { entities: { type: "array", maxItems: 5000, items: {
        type: "object", additionalProperties: false, required: ["entity_id", "name", "sense", "kind"],
        properties: {
          entity_id: { type: "string", minLength: 3, maxLength: 200, pattern: "^[a-z0-9_]+\\.[a-z0-9_]+$" }, name: { type: "string", maxLength: 200 },
          area: { type: "string", maxLength: 120 }, device_class: { type: "string", maxLength: 64 },
          sense: { type: "string", pattern: "^[a-z][a-z0-9_]*$", maxLength: 40 }, kind: { enum: ["number", "state", "event"] },
        },
      } } } } } },
      async (req, reply) => {
        const { bridgeId, accountId } = req.bridge!;
        const ids = req.body.entities.map((e) => e.entity_id);
        await deps.data.withAccount(accountId, async (s) => {
          for (const e of req.body.entities) {
            await s.db.insertInto("bridge_entities").values({
              account_id: accountId, bridge_id: bridgeId, entity_id: e.entity_id, name: e.name || e.entity_id, area: e.area || null,
              device_class: e.device_class || null, sense: e.sense, kind: e.kind, listed: true, updated_at: new Date(),
            }).onConflict((oc) => oc.columns(["bridge_id", "entity_id"]).doUpdateSet({
              name: e.name || e.entity_id, area: e.area || null, device_class: e.device_class || null, sense: e.sense, kind: e.kind, listed: true, updated_at: new Date(),
            })).execute();
          }
          let gone = s.db.updateTable("bridge_entities").set({ listed: false, updated_at: new Date() }).where("bridge_id", "=", bridgeId).where("listed", "=", true);
          if (ids.length) gone = gone.where("entity_id", "not in", ids);
          await gone.execute();
        });
        return reply.code(204).send();
      },
    );

    // The cameras the box found (ADR 0063), replacing what it listed before. Never credentials.
    scope.put<{ Body: { cameras: FoundListed[] } }>(
      "/v1/bridge/cameras-found",
      { schema: { body: { type: "object", additionalProperties: false, required: ["cameras"], properties: { cameras: { type: "array", maxItems: 200, items: foundListedSchema } } } } },
      async (req, reply) => {
        const { bridgeId, accountId } = req.bridge!;
        const now = new Date();
        const seen = new Set<string>();
        const rows = req.body.cameras.filter((c) => !seen.has(c.id) && seen.add(c.id)).map((c) => ({
          account_id: accountId, bridge_id: bridgeId, found_id: c.id, address: c.address || null, xaddr: c.xaddr || null,
          manufacturer: c.manufacturer || null, model: c.model || null, name: c.name || null, onvif: c.onvif,
          ha_entity_id: c.home_assistant?.entity_id ?? null, ha_name: c.home_assistant?.name || null, ha_area: c.home_assistant?.area || null, seen_at: now,
        }));
        await deps.data.withAccount(accountId, async (s) => {
          await s.db.deleteFrom("bridge_cameras_found").where("bridge_id", "=", bridgeId).execute();
          if (rows.length) await s.db.insertInto("bridge_cameras_found").values(rows).execute();
        });
        return reply.code(204).send();
      },
    );

    // A box choosing its own sensors (ADR 0064): the person holding a paired phone chooses on it, as an admin would in the console.
    scope.get("/v1/bridge/entities", async (req) => {
      const { bridgeId, accountId } = req.bridge!;
      const rows = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("bridge_entities").select(["entity_id", "name", "area", "sense", "kind", "source_id", "listed"])
        .where("bridge_id", "=", bridgeId).orderBy("entity_id").execute());
      return { data: rows.map((e) => ({ entity_id: e.entity_id, name: e.name, area: e.area, sense: e.sense, kind: e.kind, chosen: e.source_id !== null, listed: e.listed })) };
    });
    scope.post<{ Body: { choose?: string[]; drop?: string[] } }>(
      "/v1/bridge/entities/choose",
      { schema: { body: { type: "object", additionalProperties: false, properties: {
        choose: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 200 } },
        drop: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 200 } },
      } } } },
      async (req, reply) => {
        const { bridgeId, accountId } = req.bridge!;
        const max = await deps.maxSources(accountId);
        await deps.data.withAccount(accountId, (s) => chooseEntities(s, bridgeId, req.body.choose ?? [], req.body.drop ?? [], max));
        await deps.audit?.write({ accountId, actor: `bridge:${bridgeId}`, action: "bridge.entities_chosen", target: bridgeId, status: 204,
          details: { chose: req.body.choose?.length ?? 0, dropped: req.body.drop?.length ?? 0 } });
        return reply.code(204).send();
      },
    );

    // Readings of chosen entities, each filed under its room's sensor source; anything else is ignored.
    scope.post<{ Body: { readings: ReadingInput[] } }>(
      "/v1/bridge/readings",
      { schema: { body: { type: "object", additionalProperties: false, required: ["readings"], properties: { readings: { type: "array", minItems: 1, maxItems: 1000, items: readingInputSchema } } } } },
      async (req, reply) => {
        const { bridgeId, accountId } = req.bridge!;
        const now = new Date();
        const readings = req.body.readings.map((r) => ({ input: r, clean: cleanReading(r, now) })).sort((a, b) => a.clean.at.getTime() - b.clean.at.getTime());
        const out = await deps.data.withAccount(accountId, async (s) => {
          const ids = [...new Set(readings.map((r) => r.input.device?.id).filter((x): x is string => !!x))];
          const chosen = ids.length ? await s.db.selectFrom("bridge_entities").select(["entity_id", "sense", "source_id", "name"]).where("bridge_id", "=", bridgeId)
            .where("entity_id", "in", ids).where("source_id", "is not", null).execute() : [];
          const byEntity = new Map(chosen.map((e) => [e.entity_id, e]));
          const bySource = new Map<string, typeof readings[number]["clean"][]>();
          let ignored = 0;
          for (const r of readings) {
            const e = r.input.device ? byEntity.get(r.input.device.id) : undefined;
            if (!e || e.sense !== r.clean.sense) {
              ignored++;
              continue;
            }
            // The name a person sees is the one listed (and Home Assistant's own when it sends one).
            const clean = { ...r.clean, device_name: r.clean.device_name ?? e.name };
            bySource.set(e.source_id!, [...(bySource.get(e.source_id!) ?? []), clean]);
          }
          const events: string[] = [];
          for (const [sourceId, list] of bySource) {
            const src = await s.sources.get(sourceId);
            if (!src || src.type !== "sensor") {
              ignored += list.length;
              continue;
            }
            events.push(...await ingestReadings(s, accountId, src, list));
          }
          return { accepted: readings.length - ignored, ignored, events };
        });
        return reply.code(202).send(out);
      },
    );

    // Work for the box (ADR 0062), long-polled: what is waiting is handed over once, its arguments then cleared.
    scope.get<{ Querystring: { wait?: string } }>("/v1/bridge/commands", async (req) => {
      const { bridgeId, accountId } = req.bridge!;
      const until = Date.now() + Math.min(Math.max(Number(req.query.wait ?? 0) || 0, 0), 25) * 1000;
      for (;;) {
        const taken = await deps.data.withAccount(accountId, async (s) => {
          const rows = await s.db.selectFrom("bridge_commands").select(["id", "kind", "args_sealed as args"]).where("bridge_id", "=", bridgeId)
            .where("status", "=", "pending").orderBy("created_at").limit(10).forUpdate().skipLocked().execute();
          if (rows.length) {
            await s.db.updateTable("bridge_commands").set({ status: "taken", taken_at: new Date(), args_sealed: null })
              .where("id", "in", rows.map((r) => r.id)).execute();
          }
          return rows;
        });
        if (taken.length || Date.now() >= until || req.raw.destroyed) {
          return { data: taken.map((c) => ({ id: c.id, kind: c.kind, args: c.args ? JSON.parse(box().decrypt(c.args)) : {} })) };
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    });

    scope.post<{ Params: { id: string }; Body: { ok: boolean; result?: Record<string, unknown>; error?: string } }>(
      "/v1/bridge/commands/:id",
      { schema: { body: { type: "object", additionalProperties: false, required: ["ok"], properties: {
        ok: { type: "boolean" }, result: { type: "object", maxProperties: 20 }, error: { type: "string", maxLength: 500 },
      } } } },
      async (req, reply) => {
        const { bridgeId, accountId } = req.bridge!;
        const done = await deps.data.withAccount(accountId, (s) => s.db.updateTable("bridge_commands").set({
          status: req.body.ok ? "done" : "failed", result: req.body.result ? JSON.stringify(req.body.result) : null,
          error: req.body.ok ? null : redactUrls(req.body.error ?? "failed").slice(0, 500), finished_at: new Date(),
        }).where("id", "=", req.params.id).where("bridge_id", "=", bridgeId).where("status", "=", "taken").returning("kind").executeTakeFirst());
        if (!done) throw new ApiError(404, "not_found", "no such command waiting for a result");
        await deps.audit?.write({ accountId, actor: `bridge:${bridgeId}`, action: `bridge.${done.kind}_${req.body.ok ? "done" : "failed"}`, target: req.params.id, status: 200 });
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

/**
 * Chooses and drops a bridge's entities (ADR 0061): a chosen entity goes to the
 * sensor source of its room on that bridge, made on first use. Shared by the
 * console and by a box choosing for itself (a phone, ADR 0064).
 */
export async function chooseEntities(s: AccountScope, bridgeId: string, choose_: string[], drop: string[], max: number | null) {
  if (drop.length) {
    await s.db.updateTable("bridge_entities").set({ source_id: null, updated_at: new Date() }).where("bridge_id", "=", bridgeId).where("entity_id", "in", drop).execute();
  }
  const choose = choose_.length
    ? await s.db.selectFrom("bridge_entities").selectAll().where("bridge_id", "=", bridgeId).where("entity_id", "in", choose_).where("source_id", "is", null).execute()
    : [];
  const unknown = choose_.filter((id) => !choose.some((e) => e.entity_id === id));
  const already = unknown.length ? await s.db.selectFrom("bridge_entities").select("entity_id").where("bridge_id", "=", bridgeId).where("entity_id", "in", unknown).execute() : [];
  const missing = unknown.filter((id) => !already.some((e) => e.entity_id === id));
  if (missing.length) throw new ApiError(404, "not_found", `not listed by this bridge: ${missing.join(", ")}`);
  // One sensor source per bridge and room ("Kitchen"); entities without a room go to "Home".
  const rooms = new Map<string, string>();
  for (const e of choose) {
    const room = e.area ?? "";
    let sourceId = rooms.get(room);
    if (!sourceId) {
      let q = s.db.selectFrom("sources").select("id").where("bridge_id", "=", bridgeId).where("type", "=", "sensor");
      q = room ? q.where("location", "=", room) : q.where("location", "is", null);
      sourceId = (await q.orderBy("created_at").executeTakeFirst())?.id;
      if (!sourceId) {
        if (max !== null && (await s.sources.list()).length >= max) {
          throw new ApiError(409, "source_limit_reached", `this account can have at most ${max} sources`, { max_registered_sources: max });
        }
        const src = await s.sources.create({ name: room ? `${room} sensors` : "Home sensors", type: "sensor", senses: [e.sense], record_audio: false, ...(room ? { location: room } : {}) });
        await s.db.updateTable("sources").set({ bridge_id: bridgeId }).where("id", "=", src.id).execute();
        sourceId = src.id;
      }
      rooms.set(room, sourceId);
    }
    await s.db.updateTable("bridge_entities").set({ source_id: sourceId, updated_at: new Date() }).where("bridge_id", "=", bridgeId).where("entity_id", "=", e.entity_id).execute();
  }
}

export interface BridgeAdminDeps {
  data: DataAccess;
  maxSources(accountId: string): Promise<number | null>;
  /** The plan's largest stream; a camera added from the list gets the profile that fits it (ADR 0063). */
  maxResolution?(accountId: string): Promise<"720p" | "1080p">;
  audit?: AuditLog;
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * The console's side of bridges (ADR 0061): add a bridge (for a Home
 * Assistant box, with or without cameras), list them, and choose which of a
 * bridge's Home Assistant entities Senseplane gets. A chosen entity goes to
 * the sensor source of its room, made on first use.
 */
export function registerBridgeAdminRoutes(app: FastifyInstance, deps: BridgeAdminDeps) {
  const toBridge = (b: { id: string; name: string; version: string | null; last_seen_at: Date | null; created_at: Date; home_connected: boolean | null; home_entities: number | null; home_sending: number | null; matter_connected: boolean | null; matter_nodes: number | null; cameras_found: number | null }) => ({
    id: b.id, name: b.name, version: b.version, created_at: iso(b.created_at), last_seen_at: iso(b.last_seen_at),
    online: !!b.last_seen_at && Date.now() - new Date(b.last_seen_at).getTime() < BRIDGE_SILENT_SECONDS * 1000,
    home_assistant: b.home_connected === null ? null : { connected: b.home_connected, entities: b.home_entities ?? 0, sending: b.home_sending ?? 0 },
    matter: b.matter_connected === null ? null : { connected: b.matter_connected, nodes: b.matter_nodes ?? 0 },
    cameras_found: b.cameras_found,
  });

  app.post<{ Body: { name: string } }>(
    "/v1/bridges",
    { schema: { body: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1, maxLength: 120 } } } } },
    async (req, reply) => {
      const accountId = req.accountId!;
      const token = newBridgeToken();
      const row = await deps.data.withAccount(accountId, (s) => s.db.insertInto("bridges").values({
        id: `brg_${randomBytes(9).toString("base64url")}`, account_id: accountId, name: req.body.name, token_hash: hashApiKey(token), prefix: token.slice(0, 8),
      }).returningAll().executeTakeFirstOrThrow());
      await deps.audit?.write({ accountId, actor: req.access?.actor ?? "account", action: "bridge.created", target: row.id, status: 201 });
      // The token is shown once.
      return reply.code(201).send({ ...toBridge(row), token });
    },
  );

  app.get("/v1/bridges", async (req) => {
    const rows = await deps.data.withAccount(req.accountId!, (s) => s.db.selectFrom("bridges").selectAll().where("revoked_at", "is", null).orderBy("created_at").execute());
    return { data: rows.map(toBridge), next_cursor: null };
  });

  const bridgeOf = async (accountId: string, id: string) => {
    const b = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("bridges").selectAll().where("id", "=", id).where("revoked_at", "is", null).executeTakeFirst());
    if (!b) throw new ApiError(404, "not_found", "bridge not found");
    return b;
  };
  const listEntities = (accountId: string, bridgeId: string) => deps.data.withAccount(accountId, (s) =>
    s.db.selectFrom("bridge_entities").selectAll().where("bridge_id", "=", bridgeId).orderBy("area").orderBy("name").execute());
  const toEntity = (e: { entity_id: string; name: string; area: string | null; device_class: string | null; sense: string; kind: string; source_id: string | null; listed: boolean }) => ({
    entity_id: e.entity_id, name: e.name, area: e.area, device_class: e.device_class, sense: e.sense, kind: e.kind,
    chosen: e.source_id !== null, source_id: e.source_id, listed: e.listed,
  });

  app.get<{ Params: { id: string } }>("/v1/bridges/:id/entities", async (req) => {
    await bridgeOf(req.accountId!, req.params.id);
    return { data: (await listEntities(req.accountId!, req.params.id)).map(toEntity), next_cursor: null };
  });

  app.patch<{ Params: { id: string }; Body: { choose?: string[]; drop?: string[] } }>(
    "/v1/bridges/:id/entities",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
      choose: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 200 } },
      drop: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 200 } },
    } } } },
    async (req) => {
      const accountId = req.accountId!;
      const bridge = await bridgeOf(accountId, req.params.id);
      const max = await deps.maxSources(accountId);
      await deps.data.withAccount(accountId, (s) => chooseEntities(s, bridge.id, req.body.choose ?? [], req.body.drop ?? [], max));
      await deps.audit?.write({ accountId, actor: req.access?.actor ?? "account", action: "bridge.entities_chosen", target: bridge.id, status: 200,
        details: { chose: req.body.choose?.length ?? 0, dropped: req.body.drop?.length ?? 0 } });
      return { data: (await listEntities(accountId, bridge.id)).map(toEntity), next_cursor: null };
    },
  );

  const toCommand = (c: { id: string; kind: string; status: string; result: Record<string, unknown> | null; error: string | null; created_at: Date; finished_at: Date | null }) => ({
    id: c.id, kind: c.kind, status: c.status, result: c.result, error: c.error, created_at: iso(c.created_at), finished_at: iso(c.finished_at),
  });

  // Add a Matter device through the box (ADR 0062): the code a person got by sharing it from its own app.
  app.post<{ Params: { id: string }; Body: { code: string } }>(
    "/v1/bridges/:id/matter",
    { schema: { body: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", minLength: 8, maxLength: 64 } } } } },
    async (req, reply) => {
      const accountId = req.accountId!;
      const bridge = await bridgeOf(accountId, req.params.id);
      const code = matterCode(req.body.code);
      if (!code) throw new ApiError(400, "validation_failed", "A Matter pairing code is 11 digits (like 3497-011-2332) or a QR code starting with MT:");
      const row = await deps.data.withAccount(accountId, (s) => s.db.insertInto("bridge_commands").values({
        id: `bcm_${randomBytes(9).toString("base64url")}`, account_id: accountId, bridge_id: bridge.id, kind: "matter_commission",
        args_sealed: deps.data.box().encrypt(JSON.stringify({ code })), created_by: req.access?.actor ?? null,
      }).returningAll().executeTakeFirstOrThrow());
      await deps.audit?.write({ accountId, actor: req.access?.actor ?? "account", action: "bridge.matter_requested", target: bridge.id, status: 202 });
      return reply.code(202).send(toCommand(row));
    },
  );

  /** Work for the box, its arguments sealed until the box takes them (ADR 0062). */
  const command = (req: FastifyRequest, bridgeId: string, kind: string, args: Record<string, unknown>) =>
    deps.data.withAccount(req.accountId!, (s) => s.db.insertInto("bridge_commands").values({
      id: `bcm_${randomBytes(9).toString("base64url")}`, account_id: req.accountId!, bridge_id: bridgeId, kind,
      args_sealed: deps.data.box().encrypt(JSON.stringify(args)), created_by: req.access?.actor ?? null,
    }).returningAll().executeTakeFirstOrThrow());

  // Cameras the box found (ADR 0063); one at the address of a camera the box already has shows it.
  app.get<{ Params: { id: string } }>("/v1/bridges/:id/cameras-found", async (req) => {
    const accountId = req.accountId!;
    const bridge = await bridgeOf(accountId, req.params.id);
    const { found, cams } = await deps.data.withAccount(accountId, async (s) => ({
      found: await s.db.selectFrom("bridge_cameras_found").selectAll().where("bridge_id", "=", bridge.id).orderBy("onvif", "desc").orderBy("address").orderBy("found_id").execute(),
      cams: await s.db.selectFrom("sources").select(["id", "rtsp_url"]).where("bridge_id", "=", bridge.id).where("type", "=", "rtsp").where("rtsp_url", "is not", null).orderBy("created_at").execute(),
    }));
    const byHost = new Map<string, string>();
    for (const c of cams) {
      const host = rtspHost(deps.data.box().decrypt(c.rtsp_url!));
      if (host && !byHost.has(host)) byHost.set(host, c.id);
    }
    return {
      data: found.map((f) => ({
        id: f.found_id, address: f.address, manufacturer: f.manufacturer, model: f.model, name: f.name, onvif: f.onvif,
        home_assistant: f.ha_entity_id ? { entity_id: f.ha_entity_id, name: f.ha_name ?? f.ha_entity_id, area: f.ha_area } : null,
        source_id: (f.address && byHost.get(f.address.toLowerCase())) ?? null, seen_at: iso(f.seen_at),
      })),
      next_cursor: null,
    };
  });

  app.post<{ Params: { id: string } }>("/v1/bridges/:id/cameras-found/search", async (req, reply) => {
    const bridge = await bridgeOf(req.accountId!, req.params.id);
    if (bridge.cameras_found === null) throw new ApiError(409, "conflict", "This box doesn't look for cameras on its network.");
    return reply.code(202).send(toCommand(await command(req, bridge.id, "onvif_search", {})));
  });

  // Add a camera the box found with ONVIF: the credentials go to the box sealed, the box gets the stream (ADR 0063).
  app.post<{ Params: { id: string }; Body: { camera: string; username: string; password: string; name?: string } }>(
    "/v1/bridges/:id/onvif",
    { schema: { body: { type: "object", additionalProperties: false, required: ["camera", "username", "password"], properties: {
      camera: { type: "string", maxLength: 200 }, username: { type: "string", minLength: 1, maxLength: 128 }, password: { type: "string", maxLength: 256 },
      name: { type: "string", minLength: 1, maxLength: 120 },
    } } } },
    async (req, reply) => {
      const accountId = req.accountId!;
      const bridge = await bridgeOf(accountId, req.params.id);
      const cam = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("bridge_cameras_found").selectAll()
        .where("bridge_id", "=", bridge.id).where("found_id", "=", req.body.camera).executeTakeFirst());
      if (!cam) throw new ApiError(404, "not_found", "The box no longer lists this camera. Look again.");
      if (!cam.onvif || !cam.xaddr) throw new ApiError(409, "conflict", "This camera can't be added from the list; add it with its RTSP address.");
      const max = await deps.maxSources(accountId);
      if (max !== null && (await deps.data.withAccount(accountId, (s) => s.sources.list())).length >= max) {
        throw new ApiError(409, "source_limit_reached", `this account can have at most ${max} sources`, { max_registered_sources: max });
      }
      const name = req.body.name?.trim() || cam.ha_name || cam.model || `Camera ${cam.address ?? ""}`.trim();
      const row = await command(req, bridge.id, "onvif_add_camera", {
        xaddr: cam.xaddr, username: req.body.username, password: req.body.password, name, max_resolution: (await deps.maxResolution?.(accountId)) ?? "720p",
      });
      await deps.audit?.write({ accountId, actor: req.access?.actor ?? "account", action: "bridge.onvif_requested", target: bridge.id, status: 202, details: { camera: cam.found_id } });
      return reply.code(202).send(toCommand(row));
    },
  );

  app.get<{ Params: { id: string; cid: string } }>("/v1/bridges/:id/commands/:cid", async (req) => {
    const row = await deps.data.withAccount(req.accountId!, (s) => s.db.selectFrom("bridge_commands").selectAll()
      .where("bridge_id", "=", req.params.id).where("id", "=", req.params.cid).executeTakeFirst());
    if (!row) throw new ApiError(404, "not_found", "command not found");
    return toCommand(row);
  });
}

/** A Matter pairing code as the box passes it on: 11 or 21 digits (the manual code), or an MT: QR payload; undefined if neither. */
export function matterCode(input: string): string | undefined {
  const t = input.trim();
  if (/^MT:[0-9A-Z.-]{19,}$/i.test(t)) return t.toUpperCase();
  const digits = t.replace(/[\s-]/g, "");
  return /^\d{11}$|^\d{21}$/.test(digits) ? digits : undefined;
}
