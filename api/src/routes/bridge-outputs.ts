// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// MQTT out (ADR 0071): what a box may publish to its MQTT broker for Home
// Assistant, only when the account turned it on for that box.
// - GET   /v1/bridge/outputs  (bridge token) long-polled: the cameras with
//                             their online state, the alerting watches, and
//                             the person, vehicle and animal detections and
//                             those watches' firings since the box's cursor
// - PATCH /v1/bridges/{id}    the console turns publishing on or off
// The box fetches; nothing reaches into it (outbound only, ADR 0045).
//
// The cursor is a position in time (an event id, or "now" as one): event ids
// are minted by the API before their transaction commits, so a little before
// the cursor is read again each time (OVERLAP_MS) and the box drops what it
// already had. The cursor never reaches further back than MAX_BACK_MS.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DataAccess } from "../data/access.js";
import { ulid } from "../data/ids.js";
import { ApiError } from "../errors.js";
import type { AuditLog } from "../module.js";
import { kickOutputs, outputsKick } from "../outputs-kick.js";
import { toBridge } from "./bridges.js";

export const DETECTIONS = ["detection.person", "detection.vehicle", "detection.animal"] as const;
export const WATCH_FIRINGS = ["watch.triggered", "reading.threshold"] as const;
const MAX_WAIT_S = 25;
const MAX_EVENTS = 100;
export const OVERLAP_MS = 5_000;
export const MAX_BACK_MS = 10 * 60_000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The lowest event id at a time: `evt_` and the ULID time part, then zeros. */
export const idAt = (ms: number) => `evt_${ulid(Math.max(0, Math.floor(ms))).slice(0, 10)}${"0".repeat(16)}`;

/** The time in an event id (its ULID's first 10 characters). */
export function timeOf(id: string): number | undefined {
  const m = /^evt_([0-9A-HJKMNP-TV-Z]{10})[0-9A-HJKMNP-TV-Z]{16}$/.exec(id);
  if (!m) return undefined;
  let t = 0;
  for (const c of m[1]!) t = t * 32 + CROCKFORD.indexOf(c);
  return t;
}

export interface BridgeOutputDeps {
  data: DataAccess;
  audit?: AuditLog;
  /** How often a waiting poll looks again without being woken, for other replicas' events (default 5 s). */
  recheckMs?: number;
}

type Row = { id: string; type: string; source_id: string; watch_id: string | null; occurred_at: Date; summary: string };

export function registerBridgeOutputRoutes(app: FastifyInstance, deps: BridgeOutputDeps) {
  const recheck = deps.recheckMs ?? 5_000;

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
      const after = req.query.after !== undefined && timeOf(req.query.after) !== undefined ? req.query.after : undefined;
      const until = Date.now() + Math.min(Math.max(Number(req.query.wait ?? 0) || 0, 0), MAX_WAIT_S) * 1000;
      let was: boolean | undefined;
      for (;;) {
        const now = Date.now();
        const out = await deps.data.withAccount(accountId, async (s) => {
          const on = !!(await s.db.selectFrom("bridges").select("mqtt_publish").where("id", "=", bridgeId).executeTakeFirst())?.mqtt_publish;
          if (!on || !after) return { on, rows: [] as Row[], watches: [] as { id: string; instruction: string }[] };
          // Only watches that alert: a tracking watch or one for an agent's inbox isn't sent to the box.
          const watches = await s.db.selectFrom("watches").select(["id", "instruction"]).where("status", "=", "active").where("mode", "=", "alert").orderBy("created_at").execute();
          const from = idAt(Math.max(timeOf(after)! - OVERLAP_MS, now - MAX_BACK_MS));
          const ids = watches.map((w) => w.id);
          const rows = await s.db.selectFrom("events").select(["id", "type", "source_id", "watch_id", "occurred_at", "summary"])
            .where("id", ">", from)
            .where((eb) => eb.or([
              eb("type", "in", [...DETECTIONS]),
              ...(ids.length ? [eb.and([eb("type", "in", [...WATCH_FIRINGS]), eb("watch_id", "in", ids)])] : []),
            ]))
            .orderBy("id").limit(MAX_EVENTS).execute();
          return { on, rows, watches };
        });
        was ??= out.on;
        const fresh = out.rows.some((r) => r.id > after!);
        if ((out.on && !after) || fresh || out.on !== was || Date.now() >= until || req.raw.destroyed) {
          // Always a position: the newest event handed over, or now when there is none newer.
          const cursor = [after ?? "", idAt(now), out.rows.at(-1)?.id ?? ""].sort().at(-1)!;
          if (!out.on) return { mqtt_publish: false, bridge_id: bridgeId, now: new Date(now).toISOString(), cursor, cameras: [], watches: [], events: [] };
          const { cameras, watches } = await deps.data.withAccount(accountId, async (s) => ({
            cameras: (await s.sources.list()).filter((c) => c.type !== "sensor"),
            watches: out.watches.length || !after ? await s.db.selectFrom("watches").select(["id", "instruction"]).where("status", "=", "active").where("mode", "=", "alert").orderBy("created_at").execute() : out.watches,
          }));
          return {
            mqtt_publish: true,
            bridge_id: bridgeId,
            now: new Date(now).toISOString(),
            cursor,
            cameras: cameras.map((c) => ({ id: c.id, name: c.name, online: c.status === "online" })),
            watches: watches.map((w) => ({ id: w.id, name: w.instruction.slice(0, 120) })),
            events: out.rows.map((e) => ({
              id: e.id, type: e.type, source_id: e.source_id, ...(e.watch_id ? { watch_id: e.watch_id } : {}),
              occurred_at: new Date(e.occurred_at).toISOString(),
              // How old it is by the server's clock: the box times its sensors by this, not by its own clock.
              age_ms: Math.max(0, now - new Date(e.occurred_at).getTime()),
              summary: e.summary.slice(0, 255),
            })),
          };
        }
        // Woken at once by an event for this account or a change of the setting here; otherwise every few seconds.
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(t);
            outputsKick.removeEventListener(accountId, done);
            req.raw.off("close", done);
            resolve();
          };
          const t = setTimeout(done, Math.max(0, Math.min(recheck, until - Date.now())));
          outputsKick.addEventListener(accountId, done);
          req.raw.once("close", done);
        });
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
        kickOutputs(accountId);
        await deps.audit?.write({ accountId, actor: req.access?.actor ?? "account", action: req.body.mqtt_publish ? "bridge.mqtt_publish_on" : "bridge.mqtt_publish_off", target: row.id, status: 200 });
      }
      return toBridge(row);
    },
  );
}

