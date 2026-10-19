// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// PATCH /v1/sources/{id}, latest snapshot, and sensor readings with sensor.threshold events.
import { canSense, grantWindowsFor } from "../access.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import type { DataAccess, Source } from "../data/access.js";
import type { Thresholds } from "../data/schema.js";
import { ApiError } from "../errors.js";
import { createEvent } from "../events.js";
import { mediaClaims } from "../media-access.js";
import type { KeyRefSealer, PlaybackSigner } from "../playback.js";
import { activeAt } from "../schedule.js";
import { toSource } from "./sources.js";

/** Lifetime of a source's "latest snapshot" link: it is a live view (ADR 0036). */
export const LATEST_TTL_SECONDS = 60;

const point = { type: "array", minItems: 2, maxItems: 2, items: { type: "number", minimum: 0, maximum: 1 } };
const polygon = { type: "array", minItems: 3, maxItems: 64, items: point };
const bound = { type: "object", additionalProperties: false, properties: { above: { type: "number" }, below: { type: "number" } } };
const UNITS: Record<string, string> = { temperature: "celsius", humidity: "percent" };

export function registerSourceConfigRoutes(app: FastifyInstance, deps: {
  data: DataAccess;
  signer?: PlaybackSigner;
  base: (req: { protocol: string; host: string }) => string;
  maxRetentionDays(accountId: string): Promise<number | null>;
  publishConfig?(accountId: string, source: Source): Promise<void>;
  storageCap?(accountId: string): Promise<number | null | undefined>;
  keyRefs?: KeyRefSealer;
}) {
  const latestClaims = (req: FastifyRequest, sourceId: string) => {
    if (!deps.keyRefs) return {};
    const now = Date.now();
    return mediaClaims(req, deps.keyRefs, sourceId, now, now) ?? {};
  };
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/v1/sources/:id",
    {
      schema: {
        body: {
          type: "object", additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            location: { type: "string", maxLength: 120 },
            site: { type: ["string", "null"], maxLength: 120 },
            record_audio: { type: "boolean" },
            retention_days: { type: ["integer", "null"], minimum: 1 },
            retention_mode: { type: ["string", "null"], enum: ["days", "fill", null] },
            retention_max_bytes: { type: ["integer", "null"], minimum: 1 },
            zones: { type: "array", maxItems: 32, items: { type: "object", required: ["name", "polygon"], additionalProperties: false, properties: { name: { type: "string", pattern: "^[a-z0-9_]{1,40}$" }, polygon } } },
            privacy_masks: { type: "array", maxItems: 32, items: polygon },
            sensor_thresholds: { type: ["object", "null"], additionalProperties: false, properties: { temperature: bound, humidity: bound } },
          },
        },
      },
    },
    async (req) => {
      const b = req.body as { retention_days?: number | null } & Record<string, unknown>;
      const max = await deps.maxRetentionDays(req.accountId!);
      if (b.retention_days && max !== null && b.retention_days > max) {
        throw new ApiError(403, "quota_exceeded", `retention_days is limited to ${max} for this account`, { max });
      }
      const set: Record<string, unknown> = {};
      if (b.retention_mode === "fill" && !("retention_max_bytes" in b) && (await deps.data.withAccount(req.accountId!, (s) => s.sources.get(req.params.id)))?.retention_max_bytes == null
        && (await deps.data.withAccount(req.accountId!, (s) => s.account.get()))?.retention_max_bytes == null && (await deps.storageCap?.(req.accountId!)) == null) {
        throw new ApiError(400, "validation_failed", "fill mode needs retention_max_bytes on this source or the account");
      }
      for (const k of ["name", "location", "site", "record_audio", "retention_days", "retention_mode", "retention_max_bytes"]) if (k in b) set[k] = b[k];
      for (const k of ["zones", "privacy_masks", "sensor_thresholds"]) if (k in b) set[k] = b[k] === null ? null : JSON.stringify(b[k]);
      if ("privacy_masks" in b) set.view_changed_at = null; // masks checked against the current view
      const row = await deps.data.withAccount(req.accountId!, async (s) => {
        // Turning audio recording on or off changes the camera's senses too.
        if ("record_audio" in b) {
          const current = await s.sources.get(req.params.id);
          if (current && current.type !== "sensor") set.senses = b.record_audio ? ["video", "audio"] : ["video"];
        }
        if (Object.keys(set).length) await s.db.updateTable("sources").set(set).where("id", "=", req.params.id).execute();
        return s.sources.get(req.params.id);
      });
      if (!row) throw new ApiError(404, "not_found", "source not found");
      await deps.publishConfig?.(req.accountId!, row);
      return toSource(row);
    },
  );

  app.get<{ Params: { id: string } }>("/v1/sources/:id/now", async (req) => {
    const accountId = req.accountId!;
    const found = await deps.data.withAccount(accountId, async (s) => {
      const src = await s.sources.get(req.params.id);
      if (!src) return undefined;
      const readings = await s.db
        .selectFrom("sensor_readings").select(["sense", "value", "unit", "measured_at"]).distinctOn("sense")
        .where("source_id", "=", src.id).orderBy("sense").orderBy("measured_at", "desc").execute();
      return { src, readings };
    });
    if (!found) throw new ApiError(404, "not_found", "source not found");
    const now = new Date().toISOString();
    const isVideo = found.src.senses.includes("video") && canSense(req, found.src.id, "video");
    found.readings = found.readings.filter((r) => canSense(req, found.src.id, r.sense));
    return {
      source_id: found.src.id,
      captured_at: found.readings[0] ? new Date(found.readings[0].measured_at).toISOString() : now,
      // The "latest" link is a live view of the source, so it lives only 60 s and is re-checked on every fetch (ADR 0036).
      ...(isVideo && deps.signer
        ? { snapshot_url: `${deps.base(req)}/media/${deps.signer.sign({ kind: "latest", accountId, sourceId: found.src.id, ...latestClaims(req, found.src.id) }, LATEST_TTL_SECONDS).token}/snapshot.jpg` }
        : {}),
      ...(found.readings.length
        ? { readings: found.readings.map((r) => ({ sense: r.sense, value: r.value, unit: r.unit, measured_at: new Date(r.measured_at).toISOString() })) }
        : {}),
    };
  });

  app.post<{ Params: { id: string }; Body: { readings: { sense: "temperature" | "humidity"; value: number; unit: string; measured_at?: string; at?: string }[] } }>(
    "/v1/sources/:id/readings",
    {
      schema: {
        body: {
          type: "object", required: ["readings"], additionalProperties: false,
          properties: {
            readings: {
              type: "array", minItems: 1, maxItems: 1000,
              items: {
                type: "object", required: ["sense", "value", "unit"], additionalProperties: false,
                // `at` is accepted as an alias of `measured_at` (integrations, ADR 0045).
                properties: { sense: { enum: ["temperature", "humidity"] }, value: { type: "number" }, unit: { enum: ["celsius", "percent"] }, measured_at: { type: "string" }, at: { type: "string" } },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const accountId = req.accountId!;
      const readings = req.body.readings
        .map((r) => ({ ...r, at: (r.measured_at ?? r.at) ? new Date((r.measured_at ?? r.at)!) : new Date() }))
        .sort((a, b) => a.at.getTime() - b.at.getTime());
      for (const r of readings) {
        if (Number.isNaN(r.at.getTime())) throw new ApiError(400, "validation_failed", "measured_at must be an RFC 3339 time");
        if (UNITS[r.sense] !== r.unit) throw new ApiError(400, "validation_failed", `${r.sense} is measured in ${UNITS[r.sense]}`);
      }
      const events = await deps.data.withAccount(accountId, async (s) => {
        const src = await s.sources.get(req.params.id);
        if (!src) throw new ApiError(404, "not_found", "source not found");
        if (src.type !== "sensor") throw new ApiError(400, "validation_failed", "this source does not take sensor readings");
        const other = readings.find((r) => !src.senses.includes(r.sense));
        if (other) throw new ApiError(400, "validation_failed", `this sensor does not measure ${other.sense}`);
        for (const month of new Set(readings.map((r) => r.at.toISOString().slice(0, 7)))) {
          await sql`select ensure_readings_partition(${new Date(`${month}-01T00:00:00Z`)})`.execute(s.db);
        }
        const thresholds: Thresholds = src.sensor_thresholds ?? {};
        const created: string[] = [];
        // Watches with sensor triggers on this source (evaluated here, where readings arrive).
        const sensorWatches = (await s.db.selectFrom("watches").selectAll().where("status", "=", "active").execute())
          .filter((w) => w.sources.includes(src.id) && (w.compiled as { trigger: { type: string } }).trigger.type === "sensor");
        for (const r of readings) {
          const prev = await s.db.selectFrom("sensor_readings").select("value").where("source_id", "=", src.id)
            .where("sense", "=", r.sense).where("measured_at", "<", r.at).orderBy("measured_at", "desc").limit(1).executeTakeFirst();
          await s.db.insertInto("sensor_readings").values({ account_id: accountId, source_id: src.id, sense: r.sense, value: r.value, unit: r.unit, measured_at: r.at }).execute();
          for (const w of sensorWatches) {
            const trig = (w.compiled as { trigger: { sense: string; above?: number; below?: number; min_duration_s?: number } }).trigger;
            if (trig.sense !== r.sense) continue;
            if (!activeAt(r.at, w.active_hours, (w.compiled as { active_hours?: { days: string[]; from: string; to: string }[] | null }).active_hours)) continue;
            const out = (v: number) => (trig.above !== undefined && v > trig.above) || (trig.below !== undefined && v < trig.below);
            if (!out(r.value)) continue;
            // Start of the current run of out-of-range readings.
            const lastIn = await s.db.selectFrom("sensor_readings").select("measured_at").where("source_id", "=", src.id).where("sense", "=", r.sense)
              .where("measured_at", "<", r.at)
              .where((eb) => eb.or([
                ...(trig.above !== undefined ? [eb("value", "<=", trig.above)] : []),
                ...(trig.below !== undefined ? [eb("value", ">=", trig.below)] : []),
              ]))
              .orderBy("measured_at", "desc").limit(1).executeTakeFirst();
            const runStart = await s.db.selectFrom("sensor_readings").select("measured_at").where("source_id", "=", src.id).where("sense", "=", r.sense)
              .where("measured_at", ">", lastIn ? new Date(lastIn.measured_at) : new Date(0)).orderBy("measured_at").limit(1).executeTakeFirst();
            const started = runStart ? new Date(runStart.measured_at) : r.at;
            if ((r.at.getTime() - started.getTime()) / 1000 < (trig.min_duration_s ?? 0)) continue;
            const ev = await createEvent(s, {
              // One event per out-of-range run per watch; sensor watches fire `reading.threshold` (ADR 0045).
              event_key: `watch:${w.id}:${src.id}:${started.toISOString()}`, source_id: src.id, type: "reading.threshold", sense: r.sense,
              occurred_at: r.at, summary: `${w.instruction} — ${r.sense} is ${r.value} ${r.unit}.`, labels: [r.sense], confidence: null,
              value: { sense: r.sense, value: r.value, unit: r.unit }, watch_id: w.id,
            });
            if (ev) created.push(ev.id);
          }
          const t = thresholds[r.sense];
          if (!t) continue;
          // Fires on the crossing, not on every reading past the line.
          const crossed =
            (t.above !== undefined && r.value > t.above && (prev === undefined || prev.value <= t.above)) ||
            (t.below !== undefined && r.value < t.below && (prev === undefined || prev.value >= t.below));
          if (!crossed) continue;
          const dir = t.above !== undefined && r.value > t.above ? `above ${t.above}` : `below ${t.below}`;
          const ev = await createEvent(s, {
            event_key: `threshold:${src.id}:${r.sense}:${r.at.toISOString()}`, source_id: src.id, type: "sensor.threshold", sense: r.sense,
            occurred_at: r.at, summary: `${src.location ?? src.name}: ${r.sense} is ${r.value} ${r.unit}, ${dir}.`, labels: [r.sense],
            confidence: null, value: { sense: r.sense, value: r.value, unit: r.unit },
          });
          if (ev) created.push(ev.id);
        }
        return created;
      });
      return reply.code(202).send({ accepted: readings.length, events: events });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; sense?: string } }>("/v1/sources/:id/history", async (req) => {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 24 * 3600_000);
    // Agents only get the senses they're granted, inside each grant's time window.
    const senses = ["temperature", "humidity"].filter((s) => !req.query.sense || s === req.query.sense);
    const windows = senses.map((sense) => ({ sense, w: grantWindowsFor(req.access?.grants, req.params.id, sense) }))
      .filter((x) => x.w === "all" || x.w.length > 0);
    if (req.query.sense && !windows.length) throw new ApiError(403, "forbidden_sense", `this agent has no ${req.query.sense} grant for this source`);
    const rows = await deps.data.withAccount(req.accountId!, async (s) => {
      if (!(await s.sources.get(req.params.id))) throw new ApiError(404, "not_found", "source not found");
      if (!windows.length) return [];
      const q = s.db.selectFrom("sensor_readings").select(["sense", "value", "unit", "measured_at"]).where("source_id", "=", req.params.id)
        .where("measured_at", ">=", from).where("measured_at", "<", to)
        .where((eb) => eb.or(windows.map(({ sense, w }) => {
          if (w === "all") return eb("sense", "=", sense);
          return eb.and([eb("sense", "=", sense), eb.or(w.map((x) => eb.and([
            sql<boolean>`true`,
            ...(x.from ? [eb("measured_at", ">=", x.from)] : []),
            ...(x.to ? [eb("measured_at", "<=", x.to)] : []),
          ])))]);
        })))
        .orderBy("measured_at").limit(10_000);
      return q.execute();
    });
    return { data: rows.map((r) => ({ sense: r.sense, value: r.value, unit: r.unit, measured_at: new Date(r.measured_at).toISOString() })) };
  });
}
