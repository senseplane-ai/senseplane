// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Watches: compiled by the brain once at creation (rpc.brain.compile), stored
// here, shared with the brain through KV `watches`. Also look/ask and memory search.
import { SPEAK, canSense, grantFilter, seesSource } from "../access.js";
import { BLUR_ALL, blurFor, blurredOnly, effectiveBlur, requireBlurringBrains } from "../blur.js";
import type { Database } from "../data/schema.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { type Compiled, type Reading, candidates } from "../backtest.js";
import { DAYS, scheduleProblem, validTimeZone } from "../schedule.js";
import type { Destination, WatchSchedule } from "../data/schema.js";
import { sql } from "kysely";
import type { Selectable } from "kysely";
import type { DataAccess } from "../data/access.js";
import { newId } from "../data/ids.js";
import type { WatchesTable } from "../data/schema.js";
import { ApiError } from "../errors.js";
import { type EventUrls, toEvent } from "../events.js";
import triggerSchema from "../generated/trigger.schema.json" with { type: "json" };
import activityQuerySchema from "../generated/activity-query.schema.json" with { type: "json" };
import watchSchema from "../generated/watch.schema.json" with { type: "json" };
import destinationSchemaJson from "../generated/destination.schema.json" with { type: "json" };
import scheduleSchemaJson from "../generated/watch-schedule.schema.json" with { type: "json" };
import type { ApiBus } from "../indexer.js";
import { type ObjectStorage, readObject } from "../storage.js";
import { storeActivity } from "../brain-events.js";
import { PACKS, toPack } from "../packs.js";
import { readingText, senseName } from "../readings.js";

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormatsModule as unknown as (a: Ajv2020) => void)(ajv);
ajv.addSchema(activityQuerySchema);
ajv.addSchema(triggerSchema);
ajv.addSchema(destinationSchemaJson);
ajv.addSchema(scheduleSchemaJson);
ajv.addSchema(watchSchema);
const validateCompiled = ajv.getSchema(`${(watchSchema as { $id: string }).$id}#/properties/compiled`)!;

export type WatchRow = Selectable<WatchesTable>;

// Backtest bounds: the model check runs on at most max_checks candidates (each an AI check).
const DEFAULT_CHECKS = 10;
const MAX_CHECKS = 50;
const MAX_RANGE_MS = 7 * 86400_000;
const MAX_EVENTS = 5000;
const MAX_MATCHES = 100;

export const toWatch = (w: WatchRow) => ({
  id: w.id, instruction: w.instruction, sources: w.sources, mode: w.mode, compiled: w.compiled, estimate: w.estimate,
  status: w.status, warnings: w.warnings, expires_at: w.expires_at ? new Date(w.expires_at).toISOString() : null,
  notify: publicNotify(w.notify), active_hours: w.active_hours ?? null,
  created_at: new Date(w.created_at).toISOString(),
});

/** Destinations as the spec shows them: who added a speak action stays on the server. */
const publicNotify = (n: Destination[] | null | undefined) => (n ?? []).map(({ added_by_agent: _, ...d }) => d);

// Watch destinations and schedule (ADR 0043, 0059).
const destinationSchema = {
  type: "object", additionalProperties: false, required: ["type", "id"],
  properties: { type: { enum: destinationSchemaJson.properties.type.enum }, id: { type: "string", minLength: 1, maxLength: 64 }, text: { type: "string", minLength: 1, maxLength: 500 } },
};
const notifySchema = { type: "array", maxItems: 20, items: destinationSchema };
const scheduleSchema = {
  type: "object", additionalProperties: false, required: ["from", "to"],
  properties: {
    days: { type: "array", maxItems: 7, items: { enum: [...DAYS] } }, from: { type: "string" }, to: { type: "string" },
    time_zone: { type: "string", minLength: 1, maxLength: 64 },
  },
};

function checkSchedule(s: WatchSchedule | null | undefined) {
  if (!s) return null;
  const problem = scheduleProblem(s);
  if (problem) throw new ApiError(400, "validation_failed", problem);
  return { ...(s.days?.length ? { days: [...new Set(s.days)] } : {}), from: s.from, to: s.to, time_zone: s.time_zone ?? "UTC" };
}

/**
 * Destinations must belong to the account: webhooks that exist, agents that
 * aren't revoked, channels that are linked (ADR 0059). An agent key may route a watch only to itself (it can't see
 * the account's webhooks or other agents).
 */
export async function checkNotify(data: DataAccess, req: FastifyRequest, notify: Destination[], watch?: { created_by_agent: string | null }): Promise<Destination[]> {
  // Who added a speak action is recorded here, never taken from the client: the message is said as them (ADR 0069).
  const agent = req.access?.agentId;
  const unique = [...new Map(notify.map((d) => [`${d.type}:${d.id}`, {
    type: d.type, id: d.id, ...(d.type === "speak" ? { text: d.text?.trim() ?? "", ...(agent ? { added_by_agent: agent } : {}) } : {}),
  }])).values()];
  const speaks = unique.filter((d) => d.type === "speak");
  // An agent may make only its own watches speak; a person's watch speaks only as people set it.
  if (agent && speaks.length && watch && watch.created_by_agent !== agent) {
    throw new ApiError(403, "forbidden", "an agent can only add speak actions to watches it made");
  }
  await checkSpeak(data, req, speaks);
  if (req.access?.agentId) {
    if (unique.some((d) => d.type !== "speak" && (d.type !== "agent" || d.id !== req.access!.agentId))) {
      throw new ApiError(403, "forbidden", "an agent key can only send a watch's events to itself");
    }
    return unique;
  }
  const ids = (type: Destination["type"]) => unique.filter((d) => d.type === type).map((d) => d.id);
  const [hookIds, agentIds, channelIds] = [ids("webhook"), ids("agent"), ids("channel")];
  const known = await data.withAccount(req.accountId!, async (s) => ({
    webhook: new Set(hookIds.length ? (await s.db.selectFrom("webhooks").select("id").where("id", "in", hookIds).execute()).map((r) => r.id) : []),
    agent: new Set(agentIds.length ? (await s.db.selectFrom("agents").select("id").where("id", "in", agentIds).where("revoked_at", "is", null).execute()).map((r) => r.id) : []),
    channel: new Set(channelIds.length ? (await s.db.selectFrom("channels").select("id").where("id", "in", channelIds).where("status", "!=", "unlinked").execute()).map((r) => r.id) : []),
  }));
  const unknown = unique.filter((d) => d.type !== "speak" && !known[d.type as keyof typeof known].has(d.id));
  if (unknown.length) {
    throw new ApiError(400, "validation_failed", `unknown destination(s): ${unknown.map((d) => `${d.type} ${d.id}`).join(", ")}`, { unknown });
  }
  return unique;
}

/**
 * A watch that speaks (ADR 0069): each speak action names a camera with a speaker the caller can see and
 * the text to say. An agent needs a speak grant on that camera, as it would to speak itself.
 */
async function checkSpeak(data: DataAccess, req: FastifyRequest, dests: Destination[]) {
  for (const d of dests) {
    if (!d.text) throw new ApiError(400, "validation_failed", "a speak action needs the text to say");
    if (d.text.length > 500) throw new ApiError(400, "validation_failed", "a speak action's text is at most 500 characters");
    const src = seesSource(req, d.id) ? await data.withAccount(req.accountId!, (s) => s.sources.get(d.id)) : undefined;
    if (!src) throw new ApiError(400, "validation_failed", `unknown camera for a speak action: ${d.id}`, { unknown: [{ type: "speak", id: d.id }] });
    if (src.type === "sensor" || !src.speaker) throw new ApiError(409, "no_speaker", `${src.name} has no speaker, so a watch can't speak through it.`);
    if (req.access?.grants && !canSense(req, d.id, SPEAK)) {
      throw new ApiError(403, "forbidden_sense", `This agent has no Speak permission for ${src.name}, so its watch can't speak there. A person can give it one on the Agents page.`);
    }
  }
}

/** Stops watches whose time is up (called by the API's periodic sweeper). */
export async function expireWatches(data: DataAccess, bus: ApiBus | undefined) {
  const due = await data.expiredWatches();
  for (const w of due) {
    await data.withAccount(w.account_id, (s) => s.db.updateTable("watches").set({ status: "expired", updated_at: new Date() }).where("id", "=", w.id).execute());
    await bus?.putWatch(w.account_id, w.id, null);
  }
  return due.length;
}

export const kvValue = (w: WatchRow) => ({ id: w.id, sources: w.sources, mode: w.mode, compiled: w.compiled, status: w.status, active_hours: w.active_hours ?? null });

/**
 * The watch as the brain gets it (spec/brain/valkey.json kv `watches`), with `blur` when whoever it reports
 * to only sees some of its cameras blurred (ADR 0068): the agent that made it, or an agent or chat it
 * notifies. Its model checks are then blurred whatever the cameras' own setting, so their summaries
 * describe no faces or plates. Worked out at publish time; grant changes publish the watches again.
 */
export async function watchKv(data: DataAccess, accountId: string, w: WatchRow) {
  const notify = (w.notify ?? []) as { type: string; id: string }[];
  const blurred = await data.withAccount(accountId, async (s) => {
    const agents = new Set([...(w.created_by_agent ? [w.created_by_agent] : []), ...notify.filter((d) => d.type === "agent").map((d) => d.id)]);
    const channels = notify.filter((d) => d.type === "channel").map((d) => d.id);
    if (channels.length) {
      for (const c of await s.db.selectFrom("channels").select("agent_id").where("id", "in", channels).execute()) agents.add(c.agent_id);
    }
    if (!agents.size) return false;
    const grants = await s.db.selectFrom("grants").select(["source_ids", "blurred_only"]).where("agent_id", "in", [...agents]).where("blurred_only", "=", true).execute();
    return w.sources.some((id) => blurredOnly(grants, id));
  });
  return { ...kvValue(w), ...(blurred ? { blur: BLUR_ALL } : {}) };
}

/** Publishes an account's watches again (a grant changed: who sees what blurred may have too). */
export async function republishWatches(data: DataAccess, bus: ApiBus | undefined, accountId: string) {
  if (!bus) return;
  const rows = await data.withAccount(accountId, (s) => s.db.selectFrom("watches").selectAll().where("status", "=", "active").execute());
  for (const w of rows) await bus.putWatch(accountId, w.id, await watchKv(data, accountId, w));
}

interface CompileReply {
  compiled: Record<string, unknown>;
  estimate: Record<string, unknown>;
  warnings: string[];
  compiler: string;
  needs_zone?: boolean;
  error?: string;
}

export function registerWatchRoutes(app: FastifyInstance, deps: {
  data: DataAccess; bus?: ApiBus; storage?: ObjectStorage; urls: (req: { protocol: string; host: string }) => EventUrls;
}) {
  const bus = () => {
    if (!deps.bus) throw new ApiError(503, "service_unavailable", "watches need the brain (Valkey) to be running");
    return deps.bus;
  };

  /** Sources by id or (case-insensitive) name, so "Front door" works as well as src_…; several cameras are fine. */
  /** A source's senses (video, audio, temperature, contact, ...), for grant checks. */
  const sensesOf = async (accountId: string, id: string) => (await deps.data.withAccount(accountId, (s) => s.sources.get(id)))?.senses ?? [];

  async function resolveSources(req: FastifyRequest, refs: string[]): Promise<string[]> {
    const list = await deps.data.withAccount(req.accountId!, (s) => s.sources.list());
    return [...new Set(refs.map((ref) => {
      if (list.some((x) => x.id === ref)) return ref;
      const hits = list.filter((x) => seesSource(req, x.id) && x.name.toLowerCase() === ref.trim().toLowerCase());
      if (hits.length > 1) throw new ApiError(400, "validation_failed", `"${ref}" names ${hits.length} sources; use the id`);
      return hits[0]?.id ?? ref; // unknown refs are reported as not found below
    }))];
  }

  async function compile(accountId: string, instruction: string, sources: string[]) {
    const srcs = await deps.data.withAccount(accountId, async (s) => Promise.all(sources.map((id) => s.sources.get(id))));
    const missing = sources.filter((_, i) => !srcs[i]);
    if (missing.length) throw new ApiError(404, "not_found", `source(s) not found: ${missing.join(", ")}`);
    const zones = [...new Set(srcs.flatMap((x) => (x!.zones ?? []).map((z) => z.name)))];
    const senses = [...new Set(srcs.flatMap((x) => x!.senses))];
    // Existing watches on these sources, so a condition or digest can measure what they track (ADR 0057).
    const watches = (await deps.data.withAccount(accountId, (s) => s.db.selectFrom("watches").select(["id", "instruction", "mode", "sources"]).execute()))
      .filter((w) => w.sources.some((id) => sources.includes(id))).map(({ id, instruction: i, mode }) => ({ id, instruction: i, mode }));
    let out: CompileReply;
    try {
      out = await bus().request<CompileReply>("rpc.brain.compile", { account_id: accountId, instruction, zones, senses, watches }, 30_000);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(503, "service_unavailable", "the brain did not answer; try again shortly");
    }
    if (out.error) throw new ApiError(400, "validation_failed", out.error);
    if (!validateCompiled(out.compiled)) throw new ApiError(500, "internal", "the compiled watch did not match the spec");
    return out;
  }

  type CreateBody = { instruction: string; sources: string[]; mode?: "alert" | "track"; compiled?: Record<string, unknown>; duration_minutes?: number; notify?: Destination[]; active_hours?: WatchSchedule | null };
  /** Compiles (unless given compiled), stores and shares a watch: POST /v1/watches and packs. */
  async function createWatch(req: FastifyRequest, b: CreateBody) {
    const accountId = req.accountId!;
    const sources = await resolveSources(req, b.sources);
    for (const id of sources) {
      // An agent may watch only with senses it holds now.
      if (!seesSource(req, id)) throw new ApiError(403, "forbidden_sense", `no grant to watch ${id}`);
      const senses = await sensesOf(accountId, id); // none: an unknown source, reported as not found when compiling
      if (senses.length && !senses.some((x) => canSense(req, id, x))) throw new ApiError(403, "forbidden_sense", `no grant to watch ${id}`);
    }
    const schedule = checkSchedule(b.active_hours);
    const notify = await checkNotify(deps.data, req, b.notify ?? []);
    // A compiled watch given with the request (packs, or code that knows exactly what it wants) is used as it is.
    if (b.compiled && !validateCompiled(b.compiled)) {
      throw new ApiError(400, "validation_failed", ajv.errorsText(validateCompiled.errors), { errors: validateCompiled.errors });
    }
    const c = b.compiled
      ? { compiled: b.compiled, estimate: { vlm_calls_per_day: b.compiled.verify ? "varies" : "0" }, warnings: [] as string[], compiler: "user", needs_zone: false }
      : await compile(accountId, b.instruction, sources);
    const row = await deps.data.withAccount(accountId, (s) =>
      s.db.insertInto("watches").values({
        id: newId("wat"), account_id: accountId, instruction: b.instruction, sources, mode: b.mode ?? "alert",
        compiled: JSON.stringify(c.compiled), estimate: JSON.stringify(c.estimate), warnings: c.warnings,
        status: c.needs_zone ? "needs_zone" : "active", compiler: c.compiler,
        expires_at: b.duration_minutes ? new Date(Date.now() + b.duration_minutes * 60_000) : null,
        notify: JSON.stringify(notify), active_hours: schedule ? JSON.stringify(schedule) : null,
        created_by_agent: req.access?.agentId ?? null,
      }).returningAll().executeTakeFirstOrThrow(),
    );
    await bus().putWatch(accountId, row.id, await watchKv(deps.data, accountId, row));
    return row;
  }

  app.post<{ Body: CreateBody }>(
    "/v1/watches",
    { schema: { body: { type: "object", additionalProperties: false, required: ["instruction", "sources"], properties: {
      instruction: { type: "string", minLength: 3, maxLength: 500 }, sources: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
      mode: { enum: ["alert", "track"] }, compiled: { type: "object" },
      duration_minutes: { type: "integer", minimum: 1, maximum: 525600 }, notify: notifySchema, active_hours: { ...scheduleSchema, type: ["object", "null"] },
    } } } },
    async (req, reply) => reply.code(201).send(toWatch(await createWatch(req, req.body))),
  );

  app.get("/v1/watches", async (req) => {
    const rows = await deps.data.withAccount(req.accountId!, (s) => s.db.selectFrom("watches").selectAll().orderBy("created_at").execute());
    return { data: rows.filter((w) => w.sources.every((id) => seesSource(req, id))).map(toWatch), next_cursor: null };
  });

  app.get<{ Params: { id: string } }>("/v1/watches/:id", async (req) => {
    const row = await deps.data.withAccount(req.accountId!, (s) => s.db.selectFrom("watches").selectAll().where("id", "=", req.params.id).executeTakeFirst());
    if (!row || !row.sources.every((id) => seesSource(req, id))) throw new ApiError(404, "not_found", "watch not found");
    return toWatch(row);
  });

  app.patch<{ Params: { id: string }; Body: { instruction?: string; status?: "active" | "paused"; mode?: "alert" | "track"; compiled?: Record<string, unknown>; notify?: Destination[]; active_hours?: WatchSchedule | null } }>(
    "/v1/watches/:id",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
      instruction: { type: "string", minLength: 3, maxLength: 500 }, status: { enum: ["active", "paused"] }, mode: { enum: ["alert", "track"] }, compiled: { type: "object" },
      notify: notifySchema, active_hours: { ...scheduleSchema, type: ["object", "null"] },
    } } } },
    async (req) => {
      const accountId = req.accountId!;
      const current = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("watches").selectAll().where("id", "=", req.params.id).executeTakeFirst());
      if (!current || !current.sources.every((id) => seesSource(req, id))) throw new ApiError(404, "not_found", "watch not found");
      const set: Record<string, unknown> = { updated_at: new Date() };
      if (req.body.instruction && req.body.instruction !== current.instruction) {
        const c = await compile(accountId, req.body.instruction, current.sources);
        Object.assign(set, { instruction: req.body.instruction, compiled: JSON.stringify(c.compiled), estimate: JSON.stringify(c.estimate), warnings: c.warnings, compiler: c.compiler });
      }
      if (req.body.compiled) {
        // Hand edits are allowed (the compiled form is the user's to inspect and change), but must match the spec.
        if (!validateCompiled(req.body.compiled)) {
          throw new ApiError(400, "validation_failed", ajv.errorsText(validateCompiled.errors), { errors: validateCompiled.errors });
        }
        set.compiled = JSON.stringify(req.body.compiled);
        set.compiler = "user";
      }
      if (req.body.status) set.status = req.body.status;
      if (req.body.mode) set.mode = req.body.mode;
      if ("active_hours" in req.body) {
        const schedule = checkSchedule(req.body.active_hours);
        set.active_hours = schedule ? JSON.stringify(schedule) : null;
      }
      if (req.body.notify) set.notify = JSON.stringify(await checkNotify(deps.data, req, req.body.notify, current));
      const row = await deps.data.withAccount(accountId, (s) =>
        s.db.updateTable("watches").set(set).where("id", "=", req.params.id).returningAll().executeTakeFirstOrThrow(),
      );
      await bus().putWatch(accountId, row.id, await watchKv(deps.data, accountId, row));
      return toWatch(row);
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/watches/:id", async (req, reply) => {
    if (req.access?.grants) {
      const w = await deps.data.withAccount(req.accountId!, (s) => s.db.selectFrom("watches").select("sources").where("id", "=", req.params.id).executeTakeFirst());
      if (!w || !w.sources.every((id) => seesSource(req, id))) throw new ApiError(404, "not_found", "watch not found");
    }
    const r = await deps.data.withAccount(req.accountId!, (s) => s.db.deleteFrom("watches").where("id", "=", req.params.id).executeTakeFirst());
    if (!r.numDeletedRows) throw new ApiError(404, "not_found", "watch not found");
    await deps.bus?.putWatch(req.accountId!, req.params.id, null);
    return reply.code(204).send();
  });

  type TestBody = {
    instruction?: string; watch_id?: string; compiled?: Compiled; sources?: string[]; from: string; to: string;
    active_hours?: WatchSchedule | null; max_checks?: number;
  };
  /** Replays a watch's cheap trigger over stored history and runs its model check on candidates (ADR 0043). */
  async function runTest(req: FastifyRequest, b: TestBody) {
    const accountId = req.accountId!;
    const from = new Date(b.from).getTime();
    const to = new Date(b.to).getTime();
    if (!(from < to)) throw new ApiError(400, "validation_failed", "from must be before to");
    if (to - from > MAX_RANGE_MS) throw new ApiError(400, "validation_failed", "test at most 7 days at a time");
    const existing = b.watch_id
      ? await deps.data.withAccount(accountId, (s) => s.db.selectFrom("watches").selectAll().where("id", "=", b.watch_id!).executeTakeFirst())
      : undefined;
    if (b.watch_id && (!existing || !existing.sources.every((id) => seesSource(req, id)))) throw new ApiError(404, "not_found", "watch not found");
    const sources = b.sources ? await resolveSources(req, b.sources) : [...(existing?.sources ?? [])];
    if (!sources.length) throw new ApiError(400, "validation_failed", "sources is required");
    for (const id of sources) if (!seesSource(req, id)) throw new ApiError(404, "not_found", `source not found: ${id}`);
    let compiled: Compiled;
    if (b.compiled) {
      if (!validateCompiled(b.compiled)) throw new ApiError(400, "validation_failed", ajv.errorsText(validateCompiled.errors), { errors: validateCompiled.errors });
      compiled = b.compiled;
    } else if (b.instruction) {
      compiled = (await compile(accountId, b.instruction, sources)).compiled as unknown as Compiled;
    } else if (existing) {
      compiled = existing.compiled as unknown as Compiled;
    } else {
      throw new ApiError(400, "validation_failed", "give an instruction, a compiled watch or a watch_id");
    }
    if (compiled.trigger.type === "condition" || compiled.trigger.type === "digest") {
      throw new ApiError(400, "validation_failed", "condition and digest watches are checked on a schedule; try their question with POST /v1/activity/query");
    }
    const schedule = "active_hours" in b ? checkSchedule(b.active_hours) : (existing?.active_hours ?? null);
    const maxChecks = b.max_checks ?? DEFAULT_CHECKS;

    // The stored detections and sounds (and readings for sensor triggers), as this caller may see them.
    const granted = grantFilter<Database, "events">(req, "occurred_at");
    const loaded = await deps.data.withAccount(accountId, async (s) => {
      const srcs = new Map((await s.sources.list()).filter((x) => sources.includes(x.id)).map((x) => [x.id, x]));
      const missing = sources.filter((id) => !srcs.has(id));
      if (missing.length) throw new ApiError(404, "not_found", `source(s) not found: ${missing.join(", ")}`);
      // Episodes that started up to an hour before `from` can still end (or hold) inside it.
      let q = s.db.selectFrom("events").selectAll().where("source_id", "in", sources)
        .where("occurred_at", ">=", new Date(from - 3600_000)).where("occurred_at", "<=", new Date(to))
        .where((eb) => eb.or([eb("type", "like", "detection.%"), eb("type", "=", "sound.detected")]))
        .orderBy("occurred_at").limit(MAX_EVENTS);
      if (granted) q = q.where(granted);
      const events = await q.execute();
      const sensor = compiled.trigger.type === "sensor" ? String(compiled.trigger.sense) : undefined;
      const readings = sensor
        ? await s.db.selectFrom("sensor_readings").select(["source_id", "sense", "kind", "value", "unit", "detail", "device_id", "device_name", "measured_at"]).where("source_id", "in", sources)
          .where("sense", "=", sensor).where("measured_at", ">=", new Date(from)).where("measured_at", "<=", new Date(to)).orderBy("measured_at").limit(MAX_EVENTS).execute()
        : [];
      return { srcs, events, readings, account: await s.account.get() };
    });
    if (compiled.verify) {
      const blurs = [...loaded.srcs.values()].map((x) => effectiveBlur(x, loaded.account));
      await requireBlurringBrains(deps.bus, blurs.some((x) => x.faces || x.plates) || sources.some((id) => !!blurFor(req, id).blur));
    }
    const bySource = new Map(sources.map((id) => [id, {
      events: loaded.events.filter((e) => e.source_id === id),
      readings: loaded.readings.filter((r) => r.source_id === id && canSense(req, id, r.sense, new Date(r.measured_at))) as Reading[],
    }]));
    const found = candidates(compiled, schedule, bySource, { from, to });

    const urls = deps.urls(req);
    const verify = compiled.verify;
    let checksUsed = 0;
    let noModel = false;
    const matches: Record<string, unknown>[] = [];
    for (const c of found) {
      if (matches.length >= MAX_MATCHES) break;
      const src = loaded.srcs.get(c.source_id)!;
      const media = c.event ? toEvent(c.event, src, urls).media : {};
      const base = { source_id: c.source_id, source_name: src.name, at: new Date(c.at).toISOString(), ...(c.event ? { event_id: c.event.id } : {}),
        ...(media.snapshot_url ? { snapshot_url: media.snapshot_url } : {}) };
      const cheap = c.event?.summary ?? (c.reading ? `${c.reading.device_name ?? senseName(c.reading.sense)} was ${readingText(c.reading)}.` : "The trigger fired.");
      if (!verify) {
        matches.push({ ...base, summary: cheap, verified: null, confidence: null });
        continue;
      }
      if (noModel || checksUsed >= maxChecks || !c.event?.snapshot_key || !deps.storage) continue;
      const jpeg = await readObject(deps.storage, c.event.snapshot_key).catch(() => undefined);
      if (!jpeg) continue;
      type CheckReply = { yes?: boolean | null; answer?: string; confidence?: number; error?: string };
      const out: CheckReply = await bus()
        .request<CheckReply>("rpc.brain.check", { account_id: accountId, source_id: c.source_id, prompt: verify.prompt, jpeg_b64: jpeg.toString("base64"), ...blurFor(req, c.source_id) }, 45_000)
        .catch((): CheckReply => ({ error: "timeout" }));
      if (out.error === "no_model") {
        noModel = true;
        continue;
      }
      if (out.error) throw new ApiError(503, "service_unavailable", "the brain could not check the candidates; try again");
      checksUsed++;
      if (out.yes === true && (out.confidence ?? 0) >= verify.min_confidence) {
        matches.push({ ...base, summary: out.answer || cheap, verified: true, confidence: Math.round((out.confidence ?? 0) * 1000) / 1000 });
      }
    }
    if (noModel) {
      // No vision model on this instance: report the cheap trigger's candidates, unverified (as live watches do, ADR 0028).
      matches.length = 0;
      for (const c of found.slice(0, MAX_MATCHES)) {
        const src = loaded.srcs.get(c.source_id)!;
        const media = c.event ? toEvent(c.event, src, urls).media : {};
        matches.push({ source_id: c.source_id, source_name: src.name, at: new Date(c.at).toISOString(), ...(c.event ? { event_id: c.event.id } : {}),
          ...(media.snapshot_url ? { snapshot_url: media.snapshot_url } : {}), summary: c.event?.summary ?? "The trigger fired.", verified: false, confidence: null });
      }
    }
    const checkable = verify && !noModel ? found.filter((c) => c.event?.snapshot_key).length : 0;
    return {
      matches, checks_used: checksUsed, candidates: found.length,
      unchecked: verify && !noModel ? Math.max(0, checkable - checksUsed) + (found.length - checkable) : 0,
      compiled,
    };
  }

  // --- packs (ADR 0057) ------------------------------------------------------------
  app.get("/v1/watch-packs", async () => ({ data: PACKS.map(toPack) }));

  app.post<{ Params: { id: string }; Body: { sources: string[]; items?: string[]; time_zone?: string; notify?: Destination[] } }>(
    "/v1/watch-packs/:id/apply",
    { schema: { body: { type: "object", additionalProperties: false, required: ["sources"], properties: {
      sources: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } }, items: { type: "array", items: { type: "string" } },
      time_zone: { type: "string", maxLength: 64 }, notify: notifySchema,
    } } } },
    async (req, reply) => {
      const pack = PACKS.find((p) => p.id === req.params.id);
      if (!pack) throw new ApiError(404, "not_found", "pack not found");
      const unknown = (req.body.items ?? []).filter((k) => !pack.items.some((i) => i.key === k));
      if (unknown.length) throw new ApiError(400, "validation_failed", `not in this pack: ${unknown.join(", ")}`);
      const tz = req.body.time_zone ?? (await deps.data.withAccount(req.accountId!, (s) => s.account.get()))?.time_zone ?? "UTC";
      if (!validTimeZone(tz)) throw new ApiError(400, "validation_failed", `unknown time zone "${tz}"`);
      const ids: Record<string, string> = {};
      const made = [];
      for (const item of pack.items) {
        if (req.body.items?.length && !req.body.items.includes(item.key)) continue;
        const compiled = item.compiled?.(ids);
        if (compiled) {
          const trig = compiled.trigger as { type: string; time_zone?: string; items?: { query: { what: { watch_id?: string } } }[] };
          // A digest line about a watch that wasn't added (left out of `items`) is dropped; with none left, so is the digest.
          if (trig.items) trig.items = trig.items.filter((i) => !("watch_id" in i.query.what) || i.query.what.watch_id);
          if (trig.items && !trig.items.length) continue;
          trig.time_zone = tz;
        }
        const row = await createWatch(req, {
          instruction: item.instruction, sources: req.body.sources, mode: item.mode, ...(compiled ? { compiled } : {}),
          ...(item.hours ? { active_hours: { ...item.hours, time_zone: tz } } : {}), ...(req.body.notify ? { notify: req.body.notify } : {}),
        });
        ids[item.key] = row.id;
        made.push(toWatch(row));
      }
      return reply.code(201).send({ pack: pack.id, watches: made });
    },
  );

  // --- backtest (ADR 0043) -------------------------------------------------------
  app.post<{ Body: {
    instruction?: string; watch_id?: string; compiled?: Compiled; sources?: string[]; from: string; to: string;
    active_hours?: WatchSchedule | null; max_checks?: number;
  } }>(
    "/v1/watches/test",
    { schema: { body: { type: "object", additionalProperties: false, required: ["from", "to"], properties: {
      instruction: { type: "string", minLength: 3, maxLength: 500 }, watch_id: { type: "string" }, compiled: { type: "object" },
      sources: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
      from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" },
      active_hours: { ...scheduleSchema, type: ["object", "null"] }, max_checks: { type: "integer", minimum: 0, maximum: MAX_CHECKS },
    } } } },
    async (req) => runTest(req, req.body),
  );

  // Checking history after the fact (ADR 0057): a watch's check over stored footage. With a watch_id, what it
  // finds is kept as that watch's activities (marked `checked`), so later questions count them too.
  app.post<{ Body: { watch_id?: string; instruction?: string; sources?: string[]; from?: string; to?: string; max_checks?: number } }>(
    "/v1/activity/check",
    { schema: { body: { type: "object", additionalProperties: false, properties: {
      instruction: { type: "string", minLength: 3, maxLength: 500 }, watch_id: { type: "string" },
      sources: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
      from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, max_checks: { type: "integer", minimum: 0, maximum: MAX_CHECKS },
    } } } },
    async (req) => {
      if (!req.body.watch_id && !req.body.instruction) throw new ApiError(400, "validation_failed", "give an instruction or a watch_id");
      const to = req.body.to ?? new Date().toISOString();
      const from = req.body.from ?? new Date(Date.parse(to) - 86_400_000).toISOString();
      const out = await runTest(req, { ...req.body, from, to });
      let stored = 0;
      if (req.body.watch_id) {
        for (const m of out.matches as { source_id: string; at: string; ended_at?: string; event_id?: string; summary: string; verified: boolean | null; confidence: number | null }[]) {
          if (m.verified === false) continue; // no model ran: not known to be the thing
          await storeActivity(deps.data, req.accountId!, m.source_id, {
            activity_key: `chk:${req.body.watch_id}:${m.event_id ?? m.at}`, kind: "watch", label: req.body.watch_id, watch_id: req.body.watch_id,
            started_at: m.at, last_seen_at: m.ended_at ?? m.at, ended_at: m.ended_at ?? m.at, verified: m.verified, confidence: m.confidence ?? undefined,
            summary: m.summary, checked: true,
          }, req.log);
          stored++;
        }
      }
      return { ...out, stored };
    },
  );

  // --- look / ask --------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: { question: string } }>(
    "/v1/sources/:id/ask",
    { schema: { body: { type: "object", required: ["question"], additionalProperties: false, properties: { question: { type: "string", minLength: 3, maxLength: 500 } } } } },
    async (req) => {
      const accountId = req.accountId!;
      const src = await deps.data.withAccount(accountId, (s) => s.sources.get(req.params.id));
      if (!src) throw new ApiError(404, "not_found", "source not found");
      const camera = effectiveBlur(src, await deps.data.withAccount(accountId, (s) => s.account.get()));
      await requireBlurringBrains(deps.bus, camera.faces || camera.plates || !!blurFor(req, src.id).blur);
      type AskReply = { answer?: string; yes?: boolean | null; confidence?: number; snapshot_jpeg_b64?: string; error?: string };
      const out: AskReply = await bus()
        .request<AskReply>("rpc.brain.ask", { account_id: accountId, source_id: src.id, question: req.body.question, ...blurFor(req, src.id) }, 45_000)
        .catch((): AskReply => ({ error: "timeout" }));
      if (out.error === "no_live_frame") throw new ApiError(409, "not_found", "this source is not streaming right now");
      if (out.error === "no_model") throw new ApiError(503, "service_unavailable", "no vision model is configured on this instance");
      if (out.error) throw new ApiError(503, "service_unavailable", "the brain could not answer; try again");
      let snapshot_url: string | undefined;
      if (out.snapshot_jpeg_b64 && deps.storage) {
        const key = `snapshots/${accountId}/${src.id}/ask-${Date.now()}.jpg`;
        await deps.storage.put(key, Buffer.from(out.snapshot_jpeg_b64, "base64"), "image/jpeg");
        const u = deps.urls(req);
        const now = Date.now();
        const claims = "claims" in u && u.claims ? u.claims(src.id, now, now) ?? {} : {};
        snapshot_url = `${u.base}/media/${u.signer.sign({ kind: "object", accountId, key, ...claims }, u.ttlSeconds).token}/snapshot.jpg`;
      }
      return { answer: out.answer ?? "", confidence: out.confidence ?? 0, ...(out.yes !== undefined && out.yes !== null ? { yes: out.yes } : {}), snapshot_url };
    },
  );

  // --- memory -----------------------------------------------------------------
  app.get<{ Querystring: { q: string; from?: string; to?: string; limit?: string } }>("/v1/memory/search", async (req) => {
    const q = (req.query.q ?? "").trim();
    if (q.length < 2) throw new ApiError(400, "validation_failed", "q is required");
    const limit = Math.min(Math.max(Number(req.query.limit ?? 10), 1), 50);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 7 * 86400_000);
    const vec = (await bus().request<{ vectors: number[][] }>("rpc.brain.embed", { texts: [q] }, 10_000).catch(() => undefined))?.vectors?.[0];
    if (!vec) throw new ApiError(503, "service_unavailable", "search is unavailable: the brain did not answer");
    const rows = await deps.data.withAccount(req.accountId!, async (s) => {
      let query = s.db.selectFrom("events").selectAll()
        .select(sql<number>`1 - (embedding <=> ${`[${vec.join(",")}]`}::vector)`.as("score"))
        .where("embedding", "is not", null).where("occurred_at", ">=", from).where("occurred_at", "<", to);
      const granted = grantFilter<Database, "events">(req, "occurred_at");
      if (granted) query = query.where(granted);
      const hits = await query.orderBy(sql`embedding <=> ${`[${vec.join(",")}]`}::vector`).limit(limit).execute();
      const sources = new Map((await s.sources.list()).map((x) => [x.id, x]));
      return hits.map((h) => ({ h, src: sources.get(h.source_id) }));
    });
    const urls = deps.urls(req);
    return { data: rows.map(({ h, src }) => ({ event: toEvent(h, src, urls), score: Number(Number(h.score).toFixed(4)) })) };
  });
  return { test: runTest };
}
