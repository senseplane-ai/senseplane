// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Workflows (ADR 0072): made, changed and deleted by admins and up (and
// workspace keys); seen, with their runs, by every member of the workspace;
// never reached by agents. A definition is checked against the spec's schema
// (a closed list of step kinds: none switches a device) and as a DAG, and
// everything it names must be in the account: its sources, chats, webhooks
// and watch. The webhook trigger, POST /v1/workflow-hooks/{id}, takes no API
// key: it must carry the workflow's own signature, fresh and used once.
import { isUtf8 } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "kysely";
import type { DataAccess } from "../data/access.js";
import { newId } from "../data/ids.js";
import { ApiError } from "../errors.js";
import type { AuditLog } from "../module.js";
import { validTimeZone } from "../schedule.js";
import { type WorkflowRow, type WorkflowRunRow, startRun } from "../workflow-queue.js";
import { DefinitionError, LIMITS, type ScheduleTrigger, type WorkflowDefinition, checkDefinition } from "../workflow-spec.js";
import { nextFireAt } from "../workflows.js";
import { SIGNATURE_TOLERANCE_S, parseSignature, signatureFor } from "./readings-webhook.js";

/** Signatures the hook has taken are kept this long past their time, to refuse a replay. */
const SIGNATURE_KEEP_S = 900;

export interface WorkflowRouteDeps {
  data: DataAccess;
  audit?: AuditLog;
  /** The API's public base, for the hook URL. */
  base: (req: FastifyRequest) => string;
  now?: () => number;
}

type Body = { name?: string; enabled?: boolean; sources?: string[]; trigger?: unknown; steps?: unknown; edges?: unknown };

const bad = (message: string, details?: Record<string, unknown>) => new ApiError(400, "validation_failed", message, details);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function toWorkflow(w: WorkflowRow, base: string) {
  const d = w.definition;
  return {
    id: w.id, name: w.name, enabled: w.enabled, sources: w.source_ids, trigger: d.trigger, steps: d.steps, edges: d.edges,
    ...(d.trigger.type === "webhook" ? { hook_url: `${base.replace(/\/$/, "")}/v1/workflow-hooks/${w.id}`, hook_secret_set: !!w.hook_secret } : {}),
    runs_dropped: w.runs_dropped, last_run_at: iso(w.last_run_at),
    ...(d.trigger.type === "schedule" ? { next_run_at: w.enabled ? iso(w.next_fire_at) : null } : {}),
    created_by: w.created_by, created_at: iso(w.created_at)!, updated_at: iso(w.updated_at)!,
  };
}

type StepRow = { step_id: string; kind: string; status: string; attempts: number; started_at: Date | null; finished_at: Date | null; error: string | null; output: Record<string, unknown> | null; resume_at: Date | null };

export function toRun(r: WorkflowRunRow, steps?: StepRow[], withDefinition = false) {
  const order = new Map(r.definition.steps.map((s, i) => [s.id, i]));
  return {
    id: r.id, workflow_id: r.workflow_id, workflow_name: r.workflow_name, status: r.status, trigger: r.trigger, event_id: r.event_id,
    error: r.error, failed_step: r.failed_step, created_at: iso(r.created_at)!, started_at: iso(r.started_at), finished_at: iso(r.finished_at),
    ...(r.status === "waiting" ? { resumes_at: iso(r.due_at) } : {}),
    ...(steps ? {
      steps: [...steps].sort((a, b) => (order.get(a.step_id) ?? 99) - (order.get(b.step_id) ?? 99)).map((s) => ({
        id: s.step_id, kind: s.kind, status: s.status, attempts: s.attempts, started_at: iso(s.started_at), finished_at: iso(s.finished_at),
        error: s.error, output: s.output, ...(s.status === "waiting" ? { resumes_at: iso(s.resume_at) } : {}),
      })),
    } : {}),
    ...(withDefinition ? { definition: r.definition } : {}),
  };
}

const newHookSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

export function registerWorkflowRoutes(app: FastifyInstance, deps: WorkflowRouteDeps) {
  const { data } = deps;
  const now = deps.now ?? Date.now;

  /** Checks a whole workflow: the definition, then everything it names against the account. */
  async function check(accountId: string, b: Required<Pick<Body, "sources">> & Body): Promise<WorkflowDefinition> {
    let def: WorkflowDefinition;
    try {
      def = checkDefinition({ trigger: b.trigger, steps: b.steps, edges: b.edges ?? [] }, b.sources);
    } catch (err) {
      if (err instanceof DefinitionError) throw bad(err.message, { problems: err.problems });
      throw err;
    }
    const t = def.trigger;
    if (t.type === "schedule" && t.time_zone && !validTimeZone(t.time_zone)) throw bad(`trigger.time_zone: ${t.time_zone} isn't an IANA time zone`);
    await data.withAccount(accountId, async (s) => {
      const sources = new Map((await s.sources.list()).map((x) => [x.id, x]));
      const unknown = b.sources.filter((id) => !sources.has(id));
      if (unknown.length) throw bad(`unknown sources: ${unknown.join(", ")}`, { unknown });
      for (const st of def.steps) {
        if (st.kind === "speak") {
          const src = sources.get(st.source)!;
          if (src.type === "sensor" || !src.speaker) throw bad(`${st.id}: ${src.name} has no speaker`);
        }
        if ((st.kind === "ask") && st.source && sources.get(st.source)!.type === "sensor") throw bad(`${st.id}: ${sources.get(st.source)!.name} is a sensor; ask looks at a camera`);
        if (st.kind === "story") for (const id of st.sources ?? []) if (sources.get(id)!.type === "sensor") throw bad(`${st.id}: ${sources.get(id)!.name} is a sensor`);
        if (st.kind === "notify") {
          const table = st.to.type === "channel" ? "channels" : "webhooks";
          const found = await s.db.selectFrom(table).select("id").where("id", "=", st.to.id).executeTakeFirst();
          if (!found) throw bad(`${st.id}: there is no ${st.to.type} ${st.to.id} in this workspace`, { unknown: [st.to.id] });
        }
      }
      if (t.type === "event" && t.watch_id) {
        const w = await s.db.selectFrom("watches").select("id").where("id", "=", t.watch_id).executeTakeFirst();
        if (!w) throw bad(`trigger.watch_id: there is no watch ${t.watch_id}`, { unknown: [t.watch_id] });
      }
    });
    return def;
  }

  const load = async (accountId: string, id: string) => {
    const w = await data.withAccount(accountId, (s) => s.db.selectFrom("workflows").selectAll().where("id", "=", id).executeTakeFirst());
    if (!w) throw new ApiError(404, "not_found", "workflow not found");
    return w;
  };
  const tzOf = async (accountId: string) => (await data.withAccount(accountId, (s) => s.account.get()))?.time_zone || "UTC";
  const nextFire = (def: WorkflowDefinition, enabled: boolean, tz: string) =>
    def.trigger.type === "schedule" && enabled ? nextFireAt(def.trigger as ScheduleTrigger, tz, new Date(now()), false) : null;

  const workflowBody = {
    type: "object", additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: 100 }, enabled: { type: "boolean" },
      sources: { type: "array", minItems: 1, maxItems: LIMITS.sources, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 64 } },
      // Checked in full (spec/schemas/workflow.json and as a graph) by the handler, so the problem is named.
      trigger: { type: "object" }, steps: { type: "array" }, edges: { type: "array" },
    },
  };

  app.get("/v1/workflows", async (req) => {
    const rows = await data.withAccount(req.accountId!, (s) => s.db.selectFrom("workflows").selectAll().orderBy("created_at", "desc").execute());
    return { data: rows.map((w) => toWorkflow(w, deps.base(req))), next_cursor: null };
  });

  app.post<{ Body: Body }>("/v1/workflows", { schema: { body: { ...workflowBody, required: ["name", "sources", "trigger", "steps"] } } }, async (req, reply) => {
    const accountId = req.accountId!;
    const b = req.body as Required<Pick<Body, "name" | "sources">> & Body;
    const def = await check(accountId, b);
    const enabled = b.enabled ?? true;
    const secret = def.trigger.type === "webhook" ? newHookSecret() : undefined;
    const tz = await tzOf(accountId);
    const row = await data.withAccount(accountId, async (s) => {
      const count = Number((await s.db.selectFrom("workflows").select((e) => e.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);
      if (count >= LIMITS.workflows) throw new ApiError(409, "limit_reached", `a workspace has at most ${LIMITS.workflows} workflows`);
      return s.db.insertInto("workflows").values({
        id: newId("wfl"), account_id: accountId, name: b.name.trim(), enabled, definition: JSON.stringify(def), trigger_type: def.trigger.type,
        source_ids: b.sources, hook_secret: secret ? data.box().encrypt(secret) : null, next_fire_at: nextFire(def, enabled, tz),
        created_by: req.access?.actor ?? "account", updated_by: req.access?.actor ?? "account",
      }).returningAll().executeTakeFirstOrThrow();
    });
    // The hook secret is shown once.
    return reply.code(201).send({ ...toWorkflow(row, deps.base(req)), ...(secret ? { hook_secret: secret } : {}) });
  });

  app.get<{ Params: { id: string } }>("/v1/workflows/:id", async (req) => toWorkflow(await load(req.accountId!, req.params.id), deps.base(req)));

  app.patch<{ Params: { id: string }; Body: Body }>("/v1/workflows/:id", { schema: { body: workflowBody } }, async (req) => {
    const accountId = req.accountId!;
    const w = await load(accountId, req.params.id);
    const b = req.body ?? {};
    const merged = {
      name: b.name ?? w.name, enabled: b.enabled ?? w.enabled, sources: b.sources ?? w.source_ids,
      trigger: b.trigger ?? w.definition.trigger, steps: b.steps ?? w.definition.steps, edges: b.edges ?? w.definition.edges,
    };
    const def = await check(accountId, merged);
    const secret = def.trigger.type === "webhook" && !w.hook_secret ? newHookSecret() : undefined;
    const tz = await tzOf(accountId);
    const scheduleChanged = JSON.stringify(def.trigger) !== JSON.stringify(w.definition.trigger) || merged.enabled !== w.enabled;
    const row = await data.withAccount(accountId, (s) => s.db.updateTable("workflows").set({
      name: merged.name.trim(), enabled: merged.enabled, definition: JSON.stringify(def), trigger_type: def.trigger.type, source_ids: merged.sources,
      ...(secret ? { hook_secret: data.box().encrypt(secret) } : def.trigger.type !== "webhook" ? { hook_secret: null } : {}),
      ...(scheduleChanged || def.trigger.type !== "schedule" ? { next_fire_at: nextFire(def, merged.enabled, tz) } : {}),
      updated_by: req.access?.actor ?? "account", updated_at: new Date(),
    }).where("id", "=", w.id).returningAll().executeTakeFirstOrThrow());
    return { ...toWorkflow(row, deps.base(req)), ...(secret ? { hook_secret: secret } : {}) };
  });

  app.delete<{ Params: { id: string } }>("/v1/workflows/:id", async (req, reply) => {
    await load(req.accountId!, req.params.id);
    await data.withAccount(req.accountId!, (s) => s.db.deleteFrom("workflows").where("id", "=", req.params.id).execute());
    return reply.code(204).send();
  });

  // A new hook secret: the old one stops working at once. Shown once.
  app.post<{ Params: { id: string } }>("/v1/workflows/:id/hook-secret", async (req) => {
    const w = await load(req.accountId!, req.params.id);
    if (w.definition.trigger.type !== "webhook") throw new ApiError(409, "conflict", "only a workflow with a webhook trigger has a hook secret");
    const secret = newHookSecret();
    const row = await data.withAccount(req.accountId!, async (s) => {
      await s.db.deleteFrom("workflow_hook_signatures").where("workflow_id", "=", w.id).execute();
      return s.db.updateTable("workflows").set({ hook_secret: data.box().encrypt(secret), updated_at: new Date(), updated_by: req.access?.actor ?? "account" })
        .where("id", "=", w.id).returningAll().executeTakeFirstOrThrow();
    });
    return { ...toWorkflow(row, deps.base(req)), hook_secret: secret };
  });

  // Starting one by hand (testing it, or a disabled one): as a run of its own, within the run rate.
  app.post<{ Params: { id: string }; Body: { input?: Record<string, unknown> } }>("/v1/workflows/:id/run", {
    schema: { body: { type: ["object", "null"], additionalProperties: false, properties: { input: { type: "object" } } } },
  }, async (req, reply) => {
    const w = await load(req.accountId!, req.params.id);
    if (w.definition.trigger.type === "event") {
      // An event trigger's steps read the event: a run by hand needs one.
      throw new ApiError(409, "conflict", "a workflow started by events runs when one happens; it can't be started by hand");
    }
    const input = req.body?.input;
    if (input && Buffer.byteLength(JSON.stringify(input)) > LIMITS.inputBytes) throw bad(`input is larger than ${LIMITS.inputBytes / 1024} KiB`);
    const out = await data.withAccount(req.accountId!, (s) => startRun(s, w.id, { type: "manual", by: req.access?.actor ?? "account", ...(input ? { input } : {}) }));
    if (!("run" in out)) throw new ApiError(429, "rate_limited", `this ${out.dropped === "account" ? "workspace" : "workflow"} has started as many runs as it may for now`);
    return reply.code(202).send(toRun(out.run, []));
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; status?: string } }>("/v1/workflows/:id/runs", async (req) => {
    await load(req.accountId!, req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const rows = await data.withAccount(req.accountId!, (s) => {
      let q = s.db.selectFrom("workflow_runs").selectAll().where("workflow_id", "=", req.params.id);
      if (req.query.status) q = q.where("status", "=", req.query.status as never);
      return q.orderBy("created_at", "desc").limit(limit).execute();
    });
    return { data: rows.map((r) => toRun(r)), next_cursor: null };
  });

  app.get<{ Params: { id: string } }>("/v1/workflow-runs/:id", async (req) => {
    const found = await data.withAccount(req.accountId!, async (s) => {
      const run = await s.db.selectFrom("workflow_runs").selectAll().where("id", "=", req.params.id).executeTakeFirst();
      return run ? { run, steps: await s.db.selectFrom("workflow_run_steps").selectAll().where("run_id", "=", run.id).execute() } : undefined;
    });
    if (!found) throw new ApiError(404, "not_found", "run not found");
    return toRun(found.run, found.steps, true);
  });

  // --- the webhook trigger: no API key, the workflow's own signature ---------------------
  const unsigned = (msg: string) => new ApiError(401, "unauthorized", msg);
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: LIMITS.inputBytes }, (req, raw: Buffer, done) => {
      if (!isUtf8(raw)) return done(bad("the body must be UTF-8 JSON"));
      req.rawBody = raw.toString("utf8");
      done(null, undefined);
    });
    scope.post<{ Params: { id: string } }>("/v1/workflow-hooks/:id", async (req, reply) => {
      const id = req.params.id;
      const hook = (await sql<{ account_id: string; hook_secret: string | null; enabled: boolean; trigger_type: string }>`select * from workflow_hook(${id})`.execute(data.db())).rows[0];
      if (!hook || hook.trigger_type !== "webhook" || !hook.hook_secret) throw new ApiError(404, "not_found", "no workflow with a webhook trigger has this id");
      const header = req.headers["senseplane-signature"];
      const sig = parseSignature(Array.isArray(header) ? header[0] ?? "" : header ?? "");
      if (!sig) throw unsigned("sign the request: Senseplane-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of \"t.body\"> with the workflow's hook secret");
      const clock = now();
      if (Math.abs(Math.floor(clock / 1000) - sig.t) > SIGNATURE_TOLERANCE_S) throw unsigned(`the signature's time is more than ${SIGNATURE_TOLERANCE_S / 60} minutes from now`);
      const body = req.rawBody ?? "";
      const want = Buffer.from(signatureFor(data.box().decrypt(hook.hook_secret), sig.t, body), "hex");
      const mac = sig.v1.find((v) => timingSafeEqual(Buffer.from(v, "hex"), want));
      if (!mac) throw unsigned("the signature doesn't match the body");
      let input: unknown = {};
      if (body.trim()) {
        try {
          input = JSON.parse(body);
        } catch {
          throw bad("the body isn't valid JSON");
        }
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("the body must be a JSON object");
      if (!hook.enabled) throw new ApiError(409, "conflict", "this workflow is turned off");
      const out = await data.withAccount(hook.account_id, async (s) => {
        // Each signature once, in the run's own transaction: a request that starts nothing doesn't use it up.
        await s.db.deleteFrom("workflow_hook_signatures").where("signed_at", "<", Math.floor(clock / 1000) - SIGNATURE_KEEP_S).execute();
        const fresh = await s.db.insertInto("workflow_hook_signatures").values({ account_id: hook.account_id, workflow_id: id, mac, signed_at: sig.t })
          .onConflict((oc) => oc.columns(["workflow_id", "mac"]).doNothing()).returning("mac").executeTakeFirst();
        if (!fresh) throw unsigned("this signature was already used; sign each request");
        return startRun(s, id, { type: "webhook", input: input as Record<string, unknown> });
      });
      // Over the rate: nothing ran, the drop is counted on the workflow, and the signature is spent (sign a retry afresh).
      if (!("run" in out)) throw new ApiError(429, "rate_limited", `this ${out.dropped === "account" ? "workspace" : "workflow"} has started as many runs as it may for now`);
      await deps.audit?.write({ accountId: hook.account_id, actor: "webhook", action: "workflow.hook", target: id, status: 202, details: { run: out.run.id } }).catch(() => undefined);
      return reply.code(202).send({ run_id: out.run.id, status: out.run.status });
    });
  });
}
