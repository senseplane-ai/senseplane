// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// PATCH /v1/sources/{id}, latest snapshot, and sensor readings with sensor.threshold events.
import { canSense, grantWindowsFor } from "../access.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type ExpressionBuilder, sql } from "kysely";
import type { AccountScope, DataAccess, Source } from "../data/access.js";
import type { Database, Thresholds } from "../data/schema.js";
import { ApiError } from "../errors.js";
import { createEvent } from "../events.js";
import { mediaClaims } from "../media-access.js";
import type { KeyRefSealer, PlaybackSigner } from "../playback.js";
import { type CleanReading, cleanReading, deviceMatches, holds, isSensorSense, type ReadingInput, readingInputSchema, readingText, type SensorMatch, senseName, toReading } from "../readings.js";
import { activeAt } from "../schedule.js";
import { toSource } from "./sources.js";

/** Lifetime of a source's "latest snapshot" link: it is a live view (ADR 0036). */
export const LATEST_TTL_SECONDS = 60;

const point = { type: "array", minItems: 2, maxItems: 2, items: { type: "number", minimum: 0, maximum: 1 } };
const polygon = { type: "array", minItems: 3, maxItems: 64, items: point };
const bound = { type: "object", additionalProperties: false, properties: { above: { type: "number" }, below: { type: "number" } } };

/** The latest reading per sense and device on a source; a state also says since when it has held (ADR 0060). */
export async function latestReadings(s: AccountScope, sourceId: string) {
  const latest = await s.db
    .selectFrom("sensor_readings").select(["sense", "kind", "value", "unit", "detail", "device_id", "device_name", "measured_at"])
    .distinctOn(["sense", "device_id"]).where("source_id", "=", sourceId)
    .orderBy("sense").orderBy("device_id").orderBy("measured_at", "desc").execute();
  // Readings from before integrations named their device (ADR 0060) give way to newer ones of the same sense that do.
  const named = new Map<string, number>();
  for (const r of latest) if (r.device_id) named.set(r.sense, Math.max(named.get(r.sense) ?? 0, new Date(r.measured_at).getTime()));
  const out = [];
  for (const r of latest.filter((x) => x.device_id || !(new Date(x.measured_at).getTime() < (named.get(x.sense) ?? 0)))) {
    let since: Date | null = null;
    if (r.kind === "state") {
      const same = (eb: ExpressionBuilder<Database, "sensor_readings">) => eb.and([eb("source_id", "=", sourceId), eb("sense", "=", r.sense), sql<boolean>`device_id is not distinct from ${r.device_id}`]);
      const changed = await s.db.selectFrom("sensor_readings").select("measured_at").where(same).where("value", "<>", r.value)
        .where("measured_at", "<", r.measured_at).orderBy("measured_at", "desc").limit(1).executeTakeFirst();
      const first = await s.db.selectFrom("sensor_readings").select("measured_at").where(same)
        .where("measured_at", ">", changed ? changed.measured_at : new Date(0)).orderBy("measured_at").limit(1).executeTakeFirst();
      since = first ? new Date(first.measured_at) : null;
    }
    out.push({ row: r, since });
  }
  return out;
}

/**
 * Stores checked readings on a sensor source and fires what they trigger: the
 * source's sensor watches (reading.threshold, once per run that holds) and its
 * sensor_thresholds (sensor.threshold, on the crossing). Returns the new event ids.
 */
export async function ingestReadings(s: AccountScope, accountId: string, src: Source, readings: CleanReading[]): Promise<string[]> {
  // A sensor gains each new sense its readings bring (ADR 0060); grants still decide who sees it.
  const added = [...new Set(readings.map((r) => r.sense))].filter((x) => !src.senses.includes(x));
  if (added.length) await s.db.updateTable("sources").set({ senses: [...src.senses, ...added] }).where("id", "=", src.id).execute();
  // A sensor that pushes its own readings is reporting; a box's sensors follow the box's health instead.
  if (!src.bridge_id && (src.status === "pending" || src.status === "offline")) await s.db.updateTable("sources").set({ status: "online" }).where("id", "=", src.id).execute();
  for (const month of new Set(readings.map((r) => r.at.toISOString().slice(0, 7)))) {
    await sql`select ensure_readings_partition(${new Date(`${month}-01T00:00:00Z`)})`.execute(s.db);
  }
  const thresholds: Thresholds = src.sensor_thresholds ?? {};
  const created: string[] = [];
  // Watches with sensor triggers on this source (evaluated here, where readings arrive).
  const sensorWatches = (await s.db.selectFrom("watches").selectAll().where("status", "=", "active").execute())
    .filter((w) => w.sources.includes(src.id) && (w.compiled as { trigger: { type: string } }).trigger.type === "sensor");
  const where = src.location ?? src.name;
  for (const r of readings) {
    const same = (eb: ExpressionBuilder<Database, "sensor_readings">) => eb.and([eb("source_id", "=", src.id), eb("sense", "=", r.sense), sql<boolean>`device_id is not distinct from ${r.device_id}`]);
    const prev = await s.db.selectFrom("sensor_readings").select(["value", "kind"]).where(same)
      .where("measured_at", "<", r.at).orderBy("measured_at", "desc").limit(1).executeTakeFirst();
    await s.db.insertInto("sensor_readings").values({
      account_id: accountId, source_id: src.id, sense: r.sense, kind: r.kind, value: r.value, unit: r.unit,
      detail: r.detail, device_id: r.device_id, device_name: r.device_name, measured_at: r.at,
    }).execute();
    const value = toReading({ ...r, measured_at: r.at });
    const said = `${r.device_name ?? senseName(r.sense)}${r.kind === "event" ? " " : " is "}${readingText(r)}`;
    for (const w of sensorWatches) {
      const trig = (w.compiled as { trigger: SensorMatch & { min_duration_s?: number } }).trigger;
      if (trig.sense !== r.sense || !deviceMatches(trig, r)) continue;
      if (!activeAt(r.at, w.active_hours, (w.compiled as { active_hours?: { days: string[]; from: string; to: string }[] | null }).active_hours)) continue;
      if (!holds(trig, r)) continue;
      // Start of the current run of readings that hold; an event is its own run.
      let started = r.at;
      if (r.kind !== "event") {
        const lastOut = await s.db.selectFrom("sensor_readings").select("measured_at").where(same).where("measured_at", "<", r.at)
          .where((eb) => (r.kind === "state"
            ? eb("value", "<>", (trig.state ?? true) ? 1 : 0)
            : eb.and([
              ...(trig.above !== undefined ? [eb("value", "<=", trig.above)] : []),
              ...(trig.below !== undefined ? [eb("value", ">=", trig.below)] : []),
              ...(trig.above === undefined && trig.below === undefined ? [sql<boolean>`false`] : []),
            ])))
          .orderBy("measured_at", "desc").limit(1).executeTakeFirst();
        const runStart = await s.db.selectFrom("sensor_readings").select("measured_at").where(same)
          .where("measured_at", ">", lastOut ? new Date(lastOut.measured_at) : new Date(0)).orderBy("measured_at").limit(1).executeTakeFirst();
        started = runStart ? new Date(runStart.measured_at) : r.at;
        if ((r.at.getTime() - started.getTime()) / 1000 < (trig.min_duration_s ?? 0)) continue;
      }
      const ev = await createEvent(s, {
        // One event per run that holds, per watch and device; sensor watches fire `reading.threshold` (ADR 0045).
        event_key: `watch:${w.id}:${src.id}:${started.toISOString()}${r.device_id ? `:${r.device_id}` : ""}`, source_id: src.id, type: "reading.threshold", sense: r.sense,
        occurred_at: r.at, summary: `${w.instruction} — ${said}.`, labels: [r.sense], confidence: null, value, watch_id: w.id,
      });
      if (ev) created.push(ev.id);
    }
    const t = r.kind === "number" ? thresholds[r.sense] : undefined;
    if (!t) continue;
    const before = prev && prev.kind === "number" ? prev : undefined;
    // Fires on the crossing, not on every reading past the line.
    const crossed =
      (t.above !== undefined && r.value > t.above && (before === undefined || before.value <= t.above)) ||
      (t.below !== undefined && r.value < t.below && (before === undefined || before.value >= t.below));
    if (!crossed) continue;
    const dir = t.above !== undefined && r.value > t.above ? `above ${t.above}` : `below ${t.below}`;
    const ev = await createEvent(s, {
      event_key: `threshold:${src.id}:${r.sense}:${r.at.toISOString()}${r.device_id ? `:${r.device_id}` : ""}`, source_id: src.id, type: "sensor.threshold", sense: r.sense,
      occurred_at: r.at, summary: `${where}: ${said}, ${dir}.`, labels: [r.sense], confidence: null, value,
    });
    if (ev) created.push(ev.id);
  }
  return created;
}

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
            // Privacy blurring (ADR 0068); null follows the account.
            blur_faces: { type: ["boolean", "null"] },
            blur_plates: { type: ["boolean", "null"] },
            sensor_thresholds: { type: ["object", "null"], propertyNames: { pattern: "^[a-z][a-z0-9_]*$" }, additionalProperties: bound },
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
      for (const k of ["name", "location", "site", "record_audio", "retention_days", "retention_mode", "retention_max_bytes", "blur_faces", "blur_plates"]) if (k in b) set[k] = b[k];
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
      return { src, readings: await latestReadings(s, src.id) };
    });
    if (!found) throw new ApiError(404, "not_found", "source not found");
    const now = new Date().toISOString();
    const isVideo = found.src.senses.includes("video") && canSense(req, found.src.id, "video");
    const readings = found.readings.filter((r) => canSense(req, found.src.id, r.row.sense));
    const newest = readings.reduce<Date | null>((m, r) => (!m || new Date(r.row.measured_at) > m ? new Date(r.row.measured_at) : m), null);
    return {
      source_id: found.src.id,
      captured_at: newest ? newest.toISOString() : now,
      // The "latest" link is a live view of the source, so it lives only 60 s and is re-checked on every fetch (ADR 0036).
      ...(isVideo && deps.signer
        ? { snapshot_url: `${deps.base(req)}/media/${deps.signer.sign({ kind: "latest", accountId, sourceId: found.src.id, ...latestClaims(req, found.src.id) }, LATEST_TTL_SECONDS).token}/snapshot.jpg` }
        : {}),
      ...(readings.length ? { readings: readings.map((r) => toReading(r.row, r.since)) } : {}),
    };
  });

  app.post<{ Params: { id: string }; Body: { readings: ReadingInput[] } }>(
    "/v1/sources/:id/readings",
    {
      schema: {
        body: {
          type: "object", required: ["readings"], additionalProperties: false,
          properties: { readings: { type: "array", minItems: 1, maxItems: 1000, items: readingInputSchema } },
        },
      },
    },
    async (req, reply) => {
      const accountId = req.accountId!;
      const now = new Date();
      const readings = req.body.readings.map((r) => cleanReading(r, now)).sort((a, b) => a.at.getTime() - b.at.getTime());
      const events = await deps.data.withAccount(accountId, async (s) => {
        const src = await s.sources.get(req.params.id);
        if (!src) throw new ApiError(404, "not_found", "source not found");
        if (src.type !== "sensor") throw new ApiError(400, "validation_failed", "this source does not take sensor readings");
        return ingestReadings(s, accountId, src, readings);
      });
      return reply.code(202).send({ accepted: readings.length, events: events });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; sense?: string } }>("/v1/sources/:id/history", async (req) => {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 24 * 3600_000);
    const rows = await deps.data.withAccount(req.accountId!, async (s) => {
      const src = await s.sources.get(req.params.id);
      if (!src) throw new ApiError(404, "not_found", "source not found");
      // Agents only get the senses they're granted, inside each grant's time window.
      const senses = src.senses.filter((x) => isSensorSense(x) && (!req.query.sense || x === req.query.sense));
      const windows = senses.map((sense) => ({ sense, w: grantWindowsFor(req.access?.grants, req.params.id, sense) }))
        .filter((x) => x.w === "all" || x.w.length > 0);
      if (req.query.sense && !windows.length) throw new ApiError(403, "forbidden_sense", `this agent has no ${req.query.sense} grant for this source`);
      if (!windows.length) return [];
      return s.db.selectFrom("sensor_readings").select(["sense", "kind", "value", "unit", "detail", "device_id", "device_name", "measured_at"]).where("source_id", "=", req.params.id)
        .where("measured_at", ">=", from).where("measured_at", "<", to)
        .where((eb) => eb.or(windows.map(({ sense, w }) => {
          if (w === "all") return eb("sense", "=", sense);
          return eb.and([eb("sense", "=", sense), eb.or(w.map((x) => eb.and([
            sql<boolean>`true`,
            ...(x.from ? [eb("measured_at", ">=", x.from)] : []),
            ...(x.to ? [eb("measured_at", "<=", x.to)] : []),
          ])))]);
        })))
        .orderBy("measured_at").limit(10_000).execute();
    });
    return { data: rows.map((r) => toReading(r)) };
  });
}
