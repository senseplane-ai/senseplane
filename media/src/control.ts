// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The control API (spec/media/control-api.yaml), on the public listener.
// Every route but healthz needs a single-use control token: the network is not
// the authentication. Errors are {error, detail?}.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type Callback, ROOM_EVENT_TYPES, type RoomEventType } from "./callbacks.js";
import { ROOM_CODECS, type RoomCodec } from "./codecs.js";
import type { EgressDispatcher } from "./egress/dispatch.js";
import { type EgressStart, parseEgressStart } from "./egress/validate.js";
import type { RoomManager, RoomOptions } from "./rooms.js";
import { type ReplayGuard, type Ring, verifyControlToken } from "./tokens.js";

export interface ControlDeps {
  rooms: RoomManager;
  ring: Ring;
  replay: ReplayGuard;
  /** The signal_url a room create answers (MEDIA_URL). */
  mediaUrl(): string;
  /** Absent: /control/egress answers 501. */
  egress?: EgressDispatcher;
  healthy(): boolean;
}

class Bad extends Error {
  constructor(readonly status: number, readonly error: string, readonly detail?: string) {
    super(detail ?? error);
  }
}

const isStringMap = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
const positiveInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;

export function parseCallback(v: unknown): Callback | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const c = v as { url?: unknown; token?: unknown };
  if (typeof c.url !== "string" || typeof c.token !== "string" || !c.token || !/^https?:\/\//i.test(c.url)) return undefined;
  try {
    new URL(c.url);
  } catch {
    return undefined;
  }
  return { url: c.url, token: c.token };
}

function parseOptions(v: unknown): RoomOptions {
  if (v === undefined) return {};
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Bad(400, "bad_request", "options must be an object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!["liveness", "codecs", "onDuplicateIdentity", "events"].includes(k)) throw new Bad(400, "bad_request", `unknown option ${k}`);
  const out: RoomOptions = {};
  if (o.liveness !== undefined) {
    if (o.liveness !== "humans" && o.liveness !== "any") throw new Bad(400, "bad_request", "liveness must be humans or any");
    out.liveness = o.liveness;
  }
  const list = <T extends string>(name: string, value: unknown, allowed: readonly T[]): T[] => {
    if (!Array.isArray(value) || !value.length || value.length > allowed.length || !value.every((x) => allowed.includes(x as T))) {
      throw new Bad(400, "bad_request", `${name} must be a non-empty list of ${allowed.join(", ")}`);
    }
    if (new Set(value).size !== value.length) throw new Bad(400, "bad_request", `${name} may not repeat`);
    return value as T[];
  };
  if (o.codecs !== undefined) out.codecs = list<RoomCodec>("codecs", o.codecs, ROOM_CODECS);
  if (o.events !== undefined) out.events = list<RoomEventType>("events", o.events, ROOM_EVENT_TYPES);
  if (o.onDuplicateIdentity !== undefined) {
    if (o.onDuplicateIdentity !== "replace") throw new Bad(400, "bad_request", "onDuplicateIdentity can only be replace");
    out.onDuplicateIdentity = "replace";
  }
  return out;
}

export function registerControl(app: FastifyInstance, deps: ControlDeps) {
  app.register(async (scope) => {
    scope.setErrorHandler((err, req, reply) => {
      if (err instanceof Bad) return reply.code(err.status).send({ error: err.error, ...(err.detail ? { detail: err.detail } : {}) });
      const status = (err as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500) return reply.code(status).send({ error: "bad_request", detail: (err as Error).message });
      req.log.error({ err, url: req.url }, "control request failed");
      return reply.code(500).send({ error: "internal" });
    });
    scope.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.url.split("?")[0] === "/control/healthz") return;
      const header = req.headers.authorization ?? "";
      const v = header.startsWith("Bearer ") ? verifyControlToken(header.slice(7).trim(), deps.ring) : undefined;
      if (!v?.ok) {
        if (v) req.log.warn({ reason: v.reason }, "control token refused");
        return reply.code(401).send({ error: "unauthorized" });
      }
      // Spent the moment it is honoured: a token read off the wire is worth nothing.
      if (deps.replay.consume(`control:${v.claims.jti}`, v.claims.exp) === "replayed") {
        req.log.warn({ jti: v.claims.jti }, "control token replayed");
        return reply.code(401).send({ error: "unauthorized" });
      }
    });

    scope.get("/control/healthz", async (_req, reply) =>
      deps.healthy() ? { ok: true } : reply.code(503).send({ ok: false, error: "media workers unavailable" }));

    scope.post<{ Body: Record<string, unknown> }>("/control/rooms", async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const roomId = typeof b.roomId === "string" ? b.roomId.trim() : "";
      if (!roomId) throw new Bad(400, "roomId is required");
      if (roomId.length > 200) throw new Bad(400, "roomId is too long");
      if (b.emptyTimeoutSeconds !== undefined && !positiveInt(b.emptyTimeoutSeconds)) throw new Bad(400, "emptyTimeoutSeconds must be a positive whole number of seconds");
      if (b.maxParticipants !== undefined && !positiveInt(b.maxParticipants)) throw new Bad(400, "maxParticipants must be a positive whole number");
      const options = parseOptions(b.options);
      const callback = parseCallback(b.callback);
      if (options.events && !callback) throw new Bad(400, "bad_request", "options.events needs a callback");
      const room = deps.rooms.create({
        roomId,
        ...(b.emptyTimeoutSeconds !== undefined ? { emptyTimeoutSeconds: b.emptyTimeoutSeconds as number } : {}),
        ...(b.maxParticipants !== undefined ? { maxParticipants: b.maxParticipants as number } : {}),
        metadata: isStringMap(b.metadata) ? b.metadata : {},
        callback: callback ?? null,
        options,
      });
      return { roomId: room.id, createdAt: room.record.createdAt.toISOString(), signal_url: deps.mediaUrl() };
    });

    scope.get("/control/usage", async (req) => {
      const q = req.query as { from?: string; to?: string };
      return { at: new Date().toISOString(), metered: false, from: q.from ?? null, to: q.to ?? null, live: deps.rooms.usage() };
    });

    scope.get<{ Params: { roomId: string } }>("/control/rooms/:roomId", async (req, reply) => {
      const room = deps.rooms.get(req.params.roomId);
      if (!room) return reply.code(404).send({ error: "no such room" });
      return deps.rooms.describe(room);
    });

    scope.delete<{ Params: { roomId: string } }>("/control/rooms/:roomId", async (req, reply) => {
      await deps.rooms.end(req.params.roomId, "control");
      return reply.code(204).send();
    });

    scope.delete<{ Params: { roomId: string; identity: string }; Body: unknown }>("/control/rooms/:roomId/participants/:identity", async (req, reply) => {
      const body = req.body && typeof req.body === "object" ? (req.body as { reason?: unknown }) : {};
      if (body.reason !== undefined && (typeof body.reason !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(body.reason))) {
        throw new Bad(400, "bad_request", "reason must be a short lower_snake_case word");
      }
      await deps.rooms.removeParticipant(req.params.roomId, req.params.identity, body.reason as string | undefined);
      return reply.code(204).send();
    });

    // --- egress: the caller asks for an outcome; which box runs it is ours ---
    const egress = () => {
      if (!deps.egress) throw new Bad(501, "this media plane has no egress configured");
      return deps.egress;
    };

    scope.post<{ Body: unknown }>("/control/egress", async (req, reply) => {
      const d = egress();
      let job: EgressStart;
      try {
        job = parseEgressStart(req.body);
      } catch (err) {
        throw new Bad(400, "bad_request", (err as Error).message);
      }
      const room = deps.rooms.get(job.room);
      if (!room || room.ended) throw new Bad(404, "no such room");
      const r = await d.start(job);
      return reply.code(r.status).send(r.body);
    });

    scope.get("/control/egress", async (req, reply) => {
      const room = (req.query as { room?: string }).room;
      if (!room) throw new Bad(400, "room is required");
      const r = await egress().list(room);
      return reply.code(r.status).send(r.body);
    });

    scope.get<{ Params: { id: string } }>("/control/egress/:id", async (req, reply) => {
      const r = await egress().get(req.params.id);
      return reply.code(r.status).send(r.body);
    });

    scope.delete<{ Params: { id: string } }>("/control/egress/:id", async (req, reply) => {
      const r = await egress().stop(req.params.id);
      return reply.code(r.status).send(r.body);
    });
  });
}
