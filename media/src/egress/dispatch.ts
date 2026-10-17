// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// How the control API reaches the egress role: in this process (the default,
// MEDIA_ROLES=ingress,egress), or over HTTP on a separate egress host
// (MEDIA_ROLES=ingress with MEDIA_EGRESS_URL, and MEDIA_ROLES=egress there).
// Either way the egress joins rooms through signalling, so both behave alike.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Answer, EgressManager } from "./manager.js";
import { type EgressStart, parseEgressStart } from "./validate.js";

export interface EgressDispatcher {
  start(job: EgressStart): Promise<Answer>;
  get(id: string): Promise<Answer>;
  list(room: string): Promise<Answer>;
  stop(id: string): Promise<Answer>;
}

export function localDispatcher(manager: EgressManager, signalUrl: () => string): EgressDispatcher {
  return {
    start: (job) => manager.start({ ...job, mediaUrl: job.mediaUrl ?? signalUrl() }),
    get: async (id) => manager.get(id),
    list: async (room) => manager.list(room),
    stop: (id) => manager.stop(id),
  };
}

export function remoteDispatcher(baseUrl: string, secret: string, signalUrl: () => string): EgressDispatcher {
  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    try {
      const res = await fetch(new URL(path, baseUrl), {
        method,
        headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      return { status: res.status, body: await res.json().catch(() => ({ error: "bad answer from the egress" })) };
    } catch {
      return { status: 503, body: { error: "the egress did not answer; retry" } };
    }
  };
  return {
    start: (job) => call("POST", "/egress/sessions", { ...job, mediaUrl: job.mediaUrl ?? signalUrl() }),
    get: (id) => call("GET", `/egress/sessions/${encodeURIComponent(id)}`),
    list: (room) => call("GET", `/egress/sessions?room=${encodeURIComponent(room)}`),
    stop: (id) => call("POST", `/egress/sessions/${encodeURIComponent(id)}/stop`),
  };
}

/** The egress host's private API for a split deployment, behind MEDIA_EGRESS_SECRET. */
export function registerEgressApi(app: FastifyInstance, manager: EgressManager, secret: string) {
  app.register(async (scope) => {
    scope.addHook("onRequest", async (req, reply) => {
      const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      const want = Buffer.from(secret);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return reply.code(401).send({ error: "unauthorized" });
    });
    scope.post("/egress/sessions", async (req, reply) => {
      let job: EgressStart;
      try {
        job = parseEgressStart(req.body);
      } catch (err) {
        return reply.code(400).send({ error: "bad_request", detail: (err as Error).message });
      }
      const r = await manager.start(job);
      return reply.code(r.status).send(r.body);
    });
    scope.get("/egress/sessions", async (req) => manager.list(String((req.query as { room?: string }).room ?? "")).body);
    scope.get<{ Params: { id: string } }>("/egress/sessions/:id", async (req, reply) => {
      const r = manager.get(req.params.id);
      return reply.code(r.status).send(r.body);
    });
    scope.post<{ Params: { id: string } }>("/egress/sessions/:id/stop", async (req, reply) => {
      const r = await manager.stop(req.params.id);
      return reply.code(r.status).send(r.body);
    });
  });
}
