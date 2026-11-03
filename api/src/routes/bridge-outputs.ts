// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// MQTT out (ADR 0071): what a box may publish to its MQTT broker for Home
// Assistant, only when the account turned it on for that box.
// - GET   /v1/bridge/outputs  (bridge token) long-polled: the cameras with
//                             their online state, the alerting watches, and
//                             the person, vehicle and animal detections and
//                             watch firings since the box's cursor
// - PATCH /v1/bridges/{id}    the console turns publishing on or off
// The box fetches; nothing reaches into it (outbound only, ADR 0045).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DataAccess } from "../data/access.js";
import { ApiError } from "../errors.js";
import type { AuditLog } from "../module.js";
import { toBridge } from "./bridges.js";

/** The event types a box publishes: detections become binary sensors, watch firings events. */
export const OUTPUT_EVENTS = ["detection.person", "detection.vehicle", "detection.animal", "watch.triggered", "reading.threshold"] as const;
const MAX_WAIT_S = 25;
const MAX_EVENTS = 100;

export interface BridgeOutputDeps {
  data: DataAccess;
  audit?: AuditLog;
  /** How often a waiting long-poll looks again (tests). */
  checkEveryMs?: number;
}

export function registerBridgeOutputRoutes(app: FastifyInstance, deps: BridgeOutputDeps) {
  const every = deps.checkEveryMs ?? 1000;

  app.register(async (scope) => {
    scope.addHook("onRequest", async (req) => {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const bridge = token.startsWith("brg_") ? await deps.data.authenticateBridgeToken(token) : undefined;
      if (!bridge) throw new ApiError(401, "unauthorized", "a valid bridge token is required");
      req.bridge = bridge;
    });

    scope.get<{ Querystring: { after?: string; wait?: string } }>("/v1/bridge/outputs", async (req: FastifyRequest<{ Querystring: { after?: string; wait?: string } }>) => {
      const { bridgeId, accountId } = req.bridge!;
      const after = req.query.after && /^evt_[0-9A-Za-z]{1,40}$/.test(req.query.after) ? req.query.after : undefined;
      const until = Date.now() + Math.min(Math.max(Number(req.query.wait ?? 0) || 0, 0), MAX_WAIT_S) * 1000;
      let was: boolean | undefined;
      for (;;) {
        const out = await deps.data.withAccount(accountId, async (s) => {
          const b = await s.db.selectFrom("bridges").select("mqtt_publish").where("id", "=", bridgeId).executeTakeFirst();
          const on = !!b?.mqtt_publish;
          if (!on) return { on, events: [] as { id: string; type: string; source_id: string; watch_id: string | null; occurred_at: Date; summary: string }[], newest: undefined };
          // A box without a cursor starts from now: old events are not replayed into Home Assistant.
          if (!after) {
            const newest = await s.db.selectFrom("events").select("id").orderBy("id", "desc").limit(1).executeTakeFirst();
            return { on, events: [], newest: newest?.id };
          }
          const events = await s.db.selectFrom("events").select(["id", "type", "source_id", "watch_id", "occurred_at", "summary"])
            .where("id", ">", after).where("type", "in", [...OUTPUT_EVENTS]).orderBy("id").limit(MAX_EVENTS).execute();
          return { on, events, newest: undefined };
        });
        was ??= out.on;
        const changed = out.on !== was;
        // On without a cursor: the snapshot at once. Off: it waits too, so a box that is off asks once per `wait`.
        if ((out.on && !after) || out.events.length || changed || Date.now() >= until || req.raw.destroyed) {
          if (!out.on) return { mqtt_publish: false, bridge_id: bridgeId, cursor: after ?? null, cameras: [], watches: [], events: [] };
          const { cameras, watches } = await deps.data.withAccount(accountId, async (s) => ({
            cameras: (await s.sources.list()).filter((c) => c.type !== "sensor"),
            watches: await s.db.selectFrom("watches").select(["id", "instruction", "sources"]).where("status", "=", "active").where("mode", "=", "alert").orderBy("created_at").execute(),
          }));
          const cursor = out.events.at(-1)?.id ?? after ?? out.newest ?? null;
          return {
            mqtt_publish: true,
            bridge_id: bridgeId,
            cursor,
            cameras: cameras.map((c) => ({ id: c.id, name: c.name, online: c.status === "online" })),
            watches: watches.map((w) => ({ id: w.id, name: w.instruction.slice(0, 120) })),
            events: out.events.map((e) => ({
              id: e.id, type: e.type, source_id: e.source_id, ...(e.watch_id ? { watch_id: e.watch_id } : {}),
              occurred_at: new Date(e.occurred_at).toISOString(), summary: e.summary.slice(0, 255),
            })),
          };
        }
        await new Promise((r) => setTimeout(r, every));
      }
    });
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; mqtt_publish?: boolean } }>(
    "/v1/bridges/:id",
    { schema: { body: { type: "object", additionalProperties: false, minProperties: 1, properties: {
      name: { type: "string", minLength: 1, maxLength: 120 },
      mqtt_publish: { type: "boolean" },
    } } } },
    async (req) => {
      const accountId = req.accountId!;
      const row = await deps.data.withAccount(accountId, (s) => s.db.updateTable("bridges").set(req.body).where("id", "=", req.params.id).where("revoked_at", "is", null)
        .returningAll().executeTakeFirst());
      if (!row) throw new ApiError(404, "not_found", "bridge not found");
      if (req.body.mqtt_publish !== undefined) {
        await deps.audit?.write({ accountId, actor: req.access?.actor ?? "account", action: req.body.mqtt_publish ? "bridge.mqtt_publish_on" : "bridge.mqtt_publish_off", target: row.id, status: 200 });
      }
      return toBridge(row);
    },
  );
}
