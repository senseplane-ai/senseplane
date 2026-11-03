// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The workflow engine (ADR 0072). A run is a row claimed by one API process
// with a lease and a fresh claim token (claim_workflow_runs, ADR 0058); every
// write about the run checks the token under a lock on the run's row, so a
// process that lost its claim (it hung past its lease and another took over)
// writes nothing more. Steps run one at a time in topological order; a step
// runs when one of its incoming edges was taken and is skipped otherwise. A
// wait (and a clip or story waiting for its recording) parks the run without
// a claim until it is due. A failed step fails the run, unless it may be
// retried (3 attempts in all). Speech is never retried: a message plays once
// or not at all, and one interrupted by a lost process fails as "it may or may
// not have happened".
//
// Each run acts as `workflow:<id>`, an agent-like principal whose grants are
// built before every step from the sources it names, as they are then: video
// and sensors, audio only where the camera records sound, speak only where a
// speak step names the camera, and blurred-only where the camera's blurring is
// on (ADR 0068). The engine knows the step kinds of workflow-spec.ts and no
// others; there is no step, and no import, that reaches a device.
import { createHash } from "node:crypto";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { type Kysely, type Selectable, sql } from "kysely";
import { type Access, type Grant, SPEAK, coversSense, requireRange } from "./access.js";
import { blurFor, blurredOnly, effectiveBlur, requireBlurringBrains } from "./blur.js";
import { queueBody } from "./channels.js";
import type { AccountScope, DataAccess, Source } from "./data/access.js";
import type { Database, EventsTable, WorkflowRunStepsTable, WorkflowStepStatus } from "./data/schema.js";
import { deliveryErrorText } from "./egress.js";
import { ApiError } from "./errors.js";
import type { ApiBus } from "./indexer.js";
import { startClaimLoop } from "./jobs.js";
import type { AuditLog } from "./module.js";
import { createClip } from "./routes/playback.js";
import { makeStory } from "./routes/stories.js";
import { nextCheck } from "./scheduled-watches.js";
import type { Speech } from "./speak.js";
import { type ObjectStorage, readObject } from "./storage.js";
import { escapeHtml } from "./telegram.js";
import { type WebhookSender, defaultSender, signatureHeader } from "./workers.js";
import { type WorkflowRunRow, startRun, workflowKick } from "./workflow-queue.js";
import {
  type AskStep, type ClipStep, type NotifyStep, type RunContext, type ScheduleTrigger, type SpeakStep, type Step, type StoryStep,
  type WaitStep, type WorkflowDefinition, DefinitionError, LIMITS, RETRY_SAFE, checkDefinition, conditionHolds, fillTemplate, order, speakTargets,
} from "./workflow-spec.js";

type StepRow = Selectable<WorkflowRunStepsTable>;
type EventRow = Selectable<EventsTable>;

/** A run's lease: renewed while a step works, so only a process that stopped loses it. */
export const RUN_LEASE_S = 120;
/** A run taken over this many times from a process whose lease ran out (its processes kept dying) fails. */
const MAX_TAKEOVERS = 5;
/** Before attempt 2 and 3 of a step that may be retried. */
export const RETRY_DELAYS_S = [5, 30];
/** A clip or story waits this long past the moment's end, so its recording (6 s segments) is in. */
const RECORDED_AFTER_MS = 10_000;

export interface WorkflowDeps {
  data: DataAccess;
  bus?: ApiBus;
  storage?: ObjectStorage;
  audit?: AuditLog;
  speech?: Pick<Speech, "say">;
  /** Sends the notify step's webhook POST (tests inject one). */
  send?: WebhookSender;
  /** Has the account used its AI checks for now (ask steps)? */
  checksUsedUp?(accountId: string): Promise<boolean>;
  log?: FastifyBaseLogger;
}

/** A step's result: done (with what it found), not yet (park the run `afterS` on the database's clock), or failed. */
type Outcome =
  | { status: "succeeded"; output: Record<string, unknown> }
  | { status: "waiting"; afterS: number; output?: Record<string, unknown>; attempt?: false }
  | { status: "failed"; error: string; retry?: boolean };

class LostClaim extends Error {}
const fail = (error: string, retry = false): Outcome => ({ status: "failed", error: error.slice(0, 500), retry });
/** `now() + secs` on the database's clock (ADR 0058). */
const inSecs = (secs: number) => sql<Date>`now() + make_interval(secs => ${Math.max(0, secs)})`;

/**
 * The run's principal: grants on its own sources only, as they are now (ADR 0072). Speech only on cameras
 * a speak step names, in the run's definition and, when given, in the workflow as it is now.
 */
export function workflowAccess(workflowId: string, sources: Source[], account: { blur_faces?: boolean; blur_plates?: boolean } | undefined, def: WorkflowDefinition, current?: WorkflowDefinition): Access {
  const now = current ? new Set(speakTargets(current)) : undefined;
  const speak = new Set(speakTargets(def).filter((id) => !now || now.has(id)));
  const grants: Grant[] = sources.map((src) => {
    const camera = src.type !== "sensor";
    const blur = effectiveBlur(src, account);
    return {
      source_ids: [src.id],
      senses: [...(camera ? ["video"] : []), ...(camera && src.record_audio ? ["audio"] : []), "sensors", ...(camera && speak.has(src.id) ? [SPEAK] : [])],
      window_from: null, window_to: null, abilities: ["history"],
      blurred_only: camera && (blur.faces || blur.plates),
    };
  });
  return { actor: `workflow:${workflowId}`, grants };
}

/** The shape of a request that the shared checks (grants, ranges, blurring) and makeStory read. */
const asRequest = (accountId: string, access: Access) => ({ accountId, access, log: undefined }) as unknown as FastifyRequest;

const eventContext = (e: EventRow, sourceName: string): NonNullable<RunContext["event"]> => ({
  id: e.id, type: e.type, source_id: e.source_id, source_name: sourceName, sense: e.sense, summary: e.summary, labels: e.labels,
  confidence: e.confidence, verified: e.verified ?? null, reading: e.value?.value ?? null, occurred_at: new Date(e.occurred_at).toISOString(),
});

/** An id made from the run and the step, so a step run again after a crash makes the same clip or story, once. */
export function derivedId(prefix: "clp" | "sty", runId: string, stepId: string): string {
  const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const h = createHash("sha256").update(`${runId}/${stepId}`).digest();
  let out = "";
  for (let i = 0; i < 26; i++) out += CROCKFORD[h[i]! % 32];
  return `${prefix}_${out}`;
}

export function createWorkflowEngine(deps: WorkflowDeps) {
  const { data } = deps;
  const send = deps.send ?? defaultSender();

  /** A write about a run, only while this claim holds it. */
  const guarded = <T>(accountId: string, runId: string, token: string, fn: (s: AccountScope) => Promise<T>) => data.withAccount(accountId, async (s) => {
    const held = await s.db.selectFrom("workflow_runs").select("id").where("id", "=", runId).where("claim_token", "=", token).forUpdate().executeTakeFirst();
    if (!held) throw new LostClaim();
    return fn(s);
  });
  const renew = (accountId: string, runId: string, token: string) => data.withAccount(accountId, async (s) => Number((await s.db.updateTable("workflow_runs")
    .set({ claimed_until: inSecs(RUN_LEASE_S) }).where("id", "=", runId).where("claim_token", "=", token).executeTakeFirst()).numUpdatedRows) > 0);

  const putStep = (s: AccountScope, runId: string, step: Pick<Step, "id" | "kind">, set: Partial<Omit<StepRow, "run_id" | "step_id" | "account_id" | "kind" | "resume_at">> & { status: WorkflowStepStatus; resume_at?: unknown }) => {
    const values = { ...set, output: set.output === undefined ? undefined : set.output === null ? null : JSON.stringify(set.output) };
    return s.db.insertInto("workflow_run_steps").values({ run_id: runId, step_id: step.id, account_id: s.accountId, kind: step.kind, ...values } as never)
      .onConflict((oc) => oc.columns(["run_id", "step_id"]).doUpdateSet(values as never)).execute();
  };

  async function audit(accountId: string, run: WorkflowRunRow, status: "succeeded" | "failed" | "cancelled", error?: string | null) {
    await deps.audit?.write({
      accountId, actor: `workflow:${run.workflow_id ?? "deleted"}`, action: `workflow.run_${status}`, target: run.id, status: status === "succeeded" ? 200 : status === "cancelled" ? 409 : 500,
      details: { workflow: run.workflow_id, name: run.workflow_name, trigger: run.trigger.type, ...(error ? { error } : {}), ...(run.failed_step ? { step: run.failed_step } : {}) },
    }).catch(() => undefined);
  }

  /** Ends a run: its unreached steps are recorded as skipped. */
  async function finishRun(accountId: string, run: WorkflowRunRow, token: string, def: WorkflowDefinition | undefined, status: "succeeded" | "failed" | "cancelled", error: string | null, failedStep: string | null) {
    await guarded(accountId, run.id, token, async (s) => {
      const have = new Set((await s.db.selectFrom("workflow_run_steps").select("step_id").where("run_id", "=", run.id).execute()).map((r) => r.step_id));
      for (const st of def?.steps ?? []) if (!have.has(st.id)) await putStep(s, run.id, st, { status: "skipped" });
      if (status === "cancelled") {
        await s.db.updateTable("workflow_run_steps").set({ status: "skipped", resume_at: null }).where("run_id", "=", run.id).where("status", "=", "waiting").execute();
      }
      await s.db.updateTable("workflow_runs").set({
        status, error, failed_step: failedStep, finished_at: sql`now()`, due_at: null, claimed_until: null, claim_token: null,
      }).where("id", "=", run.id).execute();
    });
    await audit(accountId, { ...run, failed_step: failedStep }, status, error);
  }

  /** Parks a run `afterS` from now, or until a time the database already holds; it holds no claim meanwhile. */
  const park = (accountId: string, runId: string, token: string, until: { afterS: number } | { at: Date }) => guarded(accountId, runId, token, (s) =>
    s.db.updateTable("workflow_runs").set({ status: "waiting", due_at: "at" in until ? until.at : inSecs(until.afterS), claimed_until: null, claim_token: null })
      .where("id", "=", runId).execute()).then(() => undefined);

  // --- the steps ------------------------------------------------------------------

  interface StepEnv {
    accountId: string;
    run: WorkflowRunRow;
    token: string;
    def: WorkflowDefinition;
    ctx: RunContext;
    event?: EventRow;
    sources: Map<string, Source>;
    access: Access;
    req: FastifyRequest;
    /** The moment a clip or story is about: the event, or the run's start. */
    moment: { from: number; to: number };
    /** The database's clock when the step started. */
    now: number;
  }

  const camera = (env: StepEnv, id: string | undefined): Source | Outcome => {
    if (!id) return fail("there is no event camera to use; name one");
    const src = env.sources.get(id);
    if (!src) return fail(`${id} isn't one of this workflow's sources (or no longer exists)`);
    if (src.type === "sensor") return fail(`${src.name} is a sensor, not a camera`);
    return src;
  };
  const isOutcome = (x: unknown): x is Outcome => !!x && typeof x === "object" && "status" in x && !("id" in x);

  async function ask(env: StepEnv, step: AskStep): Promise<Outcome> {
    const src = camera(env, step.source ?? env.event?.source_id);
    if (isOutcome(src)) return src;
    if (!deps.bus) return fail("no brain is connected, so nothing could be asked");
    if (await deps.checksUsedUp?.(env.accountId)) return fail("this account has used its AI checks for now (allowance_exhausted)");
    const account = await data.withAccount(env.accountId, (s) => s.account.get());
    const blur = effectiveBlur(src, account);
    try {
      await requireBlurringBrains(deps.bus, blur.faces || blur.plates || !!blurFor(env.req, src.id).blur);
    } catch (err) {
      return fail((err as Error).message, true);
    }
    type Reply = { yes?: boolean | null; answer?: string; confidence?: number; error?: string };
    let out: Reply;
    const snapshot = env.event && env.event.source_id === src.id && env.event.snapshot_key && deps.storage
      ? await readObject(deps.storage, env.event.snapshot_key).catch(() => undefined) : undefined;
    if (snapshot) {
      // The event's own moment, as the backtest checks it (the brain blurs it as the camera and the caller need).
      out = await deps.bus.request<Reply>("rpc.brain.check", {
        account_id: env.accountId, source_id: src.id, prompt: step.question, jpeg_b64: snapshot.toString("base64"), purpose: "workflow", ...blurFor(env.req, src.id),
      }, 45_000).catch((): Reply => ({ error: "timeout" }));
    } else {
      out = await deps.bus.request<Reply>("rpc.brain.ask", {
        account_id: env.accountId, source_id: src.id, question: step.question, purpose: "workflow", ...blurFor(env.req, src.id),
      }, 45_000).catch((): Reply => ({ error: "timeout" }));
    }
    if (out.error === "no_model") return fail("no vision model is set up on this server");
    if (out.error === "no_live_frame") return fail(`${src.name} isn't streaming right now, and the event has no snapshot`, true);
    if (out.error) return fail("the brain didn't answer", true);
    const confidence = Math.round((out.confidence ?? 0) * 1000) / 1000;
    const yes = out.yes === true && confidence >= (step.min_confidence ?? 0.5);
    return { status: "succeeded", output: { branch: yes ? "yes" : "no", yes, answer: (out.answer ?? "").slice(0, 1000), confidence, source_id: src.id } };
  }

  async function notify(env: StepEnv, step: NotifyStep): Promise<Outcome> {
    const text = fillTemplate(step.text, env.ctx);
    if (!text.trim()) return fail("the text came out empty");
    if (step.to.type === "channel") {
      // Queued and recorded as done in one transaction, under the claim: a crash can't queue it twice.
      return guarded(env.accountId, env.run.id, env.token, async (s) => {
        const ch = await s.db.selectFrom("channels").select(["id", "status", "snapshots", "muted_until"]).where("id", "=", step.to.id).executeTakeFirst();
        if (!ch) return fail(`the chat ${step.to.id} isn't linked to this workspace`);
        if (ch.status !== "active") return fail(`the chat ${step.to.id} is ${ch.status}`);
        // A chat someone muted stays quiet, as it does for watches' alerts; the step is done, and says so.
        let output: Record<string, unknown>;
        if (ch.muted_until && new Date(ch.muted_until).getTime() > env.now) output = { channel_id: ch.id, muted: true };
        else {
          // The event's snapshot when the chat takes them and the workflow may show it unblurred; otherwise text only.
          const ev = env.event;
          const photo = ev?.snapshot_key && ch.snapshots && !blurredOnly(env.access.grants, ev.source_id) ? { photo_key: ev.snapshot_key, photo_source: ev.source_id } : {};
          await queueBody(s, ch.id, { text: `<b>${escapeHtml(env.run.workflow_name)}</b>\n${escapeHtml(text)}`, ...photo });
          output = { channel_id: ch.id, text };
        }
        await putStep(s, env.run.id, step, { status: "succeeded", output, error: null, finished_at: sql`now()` as never, resume_at: null });
        return { status: "succeeded", output } as Outcome;
      });
    }
    const hook = await data.withAccount(env.accountId, (s) => s.db.selectFrom("webhooks").select(["id", "url", "secret"]).where("id", "=", step.to.id).executeTakeFirst());
    if (!hook) return fail(`the webhook ${step.to.id} doesn't exist`);
    const delivery = `${env.run.id}.${step.id}`;
    const ev = env.event;
    const body = JSON.stringify({
      type: "workflow.notify", id: delivery, created_at: new Date(env.now).toISOString(),
      workflow: { id: env.run.workflow_id, name: env.run.workflow_name }, run_id: env.run.id, step_id: step.id, text,
      ...(ev ? { event: { id: ev.id, type: ev.type, source: { id: ev.source_id, name: env.ctx.event?.source_name }, occurred_at: new Date(ev.occurred_at).toISOString(), summary: ev.summary, labels: ev.labels, confidence: ev.confidence, value: ev.value ?? null } } : {}),
      ...(env.ctx.input ? { input: env.ctx.input } : {}),
      steps: env.ctx.steps,
    });
    let status = 0;
    try {
      const res = await send(hook.url, {
        method: "POST", body, timeoutMs: 10_000,
        headers: {
          "content-type": "application/json", "user-agent": "Senseplane-Webhooks/1",
          "senseplane-signature": signatureHeader(data.box().decrypt(hook.secret), body),
          // The same on every attempt (a retry, or a run again after a crash), so a receiver can drop a repeat.
          "senseplane-delivery": delivery, "senseplane-event": "workflow.notify",
        },
      });
      status = res.status;
    } catch (err) {
      return fail(`the webhook couldn't be reached: ${deliveryErrorText(err)}`, true);
    }
    if (status >= 200 && status < 300) return { status: "succeeded", output: { webhook_id: hook.id, status_code: status, delivery } };
    return fail(`the webhook answered ${deliveryErrorText(undefined, status)}`, status === 429 || status >= 500);
  }

  async function speak(env: StepEnv, step: SpeakStep): Promise<Outcome> {
    const src = camera(env, step.source);
    if (isOutcome(src)) return src;
    const granted = env.access.grants?.some((g) => g.source_ids.includes(src.id) && coversSense(g.senses, SPEAK));
    if (!granted) return fail(`this workflow has no Speak permission for ${src.name}`);
    if (!deps.speech) return fail("talk-back isn't available on this server");
    // What a webhook sent is said aloud only when the step allows it (ADR 0072): otherwise it reads as empty.
    const ctx = step.allow_input ? env.ctx : { ...env.ctx, input: undefined };
    const text = fillTemplate(step.text, ctx, 500);
    if (!text.trim()) return fail("the text came out empty");
    const out = await deps.speech.say(env.accountId, src, { kind: "workflow", actor: `workflow:${env.run.workflow_id}`, name: `Workflow: ${env.run.workflow_name.slice(0, 80)}`, via: "workflow" }, text,
      { kind: "workflow", ...(env.event ? { eventId: env.event.id } : {}) });
    const ok = out.row.status === "playing" || out.row.status === "played" || out.row.status === "sent";
    if (ok) return { status: "succeeded", output: { message_id: out.row.id, status: out.row.status, text } };
    return fail(out.row.message ?? `nothing was said (${out.row.status})`);
  }

  /** Clips and stories are cut from the recording: wait until the moment is in (on the database's clock). */
  const recordedBy = (env: StepEnv, to: number): Outcome | undefined =>
    env.now < to + RECORDED_AFTER_MS ? { status: "waiting", afterS: Math.ceil((to + RECORDED_AFTER_MS - env.now) / 1000), attempt: false } : undefined;

  async function clip(env: StepEnv, step: ClipStep): Promise<Outcome> {
    const ev = env.event;
    if (!ev) return fail("a clip step needs an event");
    const src = camera(env, ev.source_id);
    if (isOutcome(src)) return src;
    if (!deps.storage) return fail("clips need object storage");
    const start = new Date(ev.occurred_at).getTime();
    const end = ev.ended_at ? new Date(ev.ended_at).getTime() : start;
    const from = start - (step.before_s ?? 5) * 1000;
    const to = Math.min(end + (step.after_s ?? 10) * 1000, from + 3600_000);
    const later = recordedBy(env, to);
    if (later) return later;
    try {
      requireRange(env.req, src.id, "video", new Date(from), new Date(to));
    } catch (err) {
      return fail((err as Error).message);
    }
    if (blurredOnly(env.access.grants, src.id)) return fail(`${src.name} is blurred for this workflow, and clips are made from the recording, which isn't blurred`);
    // The same id on every attempt: a step run again after a crash finds the clip it made.
    const made = await createClip({ data, storage: deps.storage }, env.accountId, src.id, from, to, `${env.run.workflow_name}: ${ev.summary}`.slice(0, 200), derivedId("clp", env.run.id, step.id));
    if (!made) return fail(`nothing was recorded on ${src.name} at that time`);
    return { status: "succeeded", output: { clip_id: made.id } };
  }

  async function story(env: StepEnv, step: StoryStep): Promise<Outcome> {
    const ids = step.sources?.length ? step.sources : env.event ? [env.event.source_id] : [];
    for (const id of ids) {
      const c = camera(env, id);
      if (isOutcome(c)) return c;
    }
    if (!deps.storage) return fail("stories need object storage");
    const from = env.moment.from - (step.before_s ?? 10) * 1000;
    const to = env.moment.to + (step.after_s ?? 20) * 1000;
    const later = recordedBy(env, to);
    if (later) return later;
    try {
      const out = await makeStory({ data, bus: deps.bus, audit: deps.audit }, env.req, {
        title: `${env.run.workflow_name}${env.event ? `: ${env.event.summary}` : ""}`.slice(0, 200), mode: step.mode ?? "labelled",
        moments: ids.map((id) => ({ source: id, from: new Date(from).toISOString(), to: new Date(to).toISOString() })),
      }, { id: derivedId("sty", env.run.id, step.id) });
      return { status: "succeeded", output: { story_id: out.story.id } };
    } catch (err) {
      return fail((err as Error).message, err instanceof ApiError && err.status >= 500);
    }
  }

  const wait = (env: StepEnv, step: WaitStep, row: StepRow | undefined): Outcome => {
    // Its second visit, once due: done.
    if (row?.status === "waiting" && row.resume_at && new Date(row.resume_at).getTime() <= env.now) return { status: "succeeded", output: { waited_s: step.seconds } };
    return { status: "waiting", afterS: step.seconds };
  };

  async function runStep(env: StepEnv, step: Step, row: StepRow | undefined): Promise<Outcome> {
    switch (step.kind) {
      case "condition": {
        const yes = conditionHolds(step, env.ctx);
        return { status: "succeeded", output: { branch: yes ? "yes" : "no", passed: yes } };
      }
      case "ask": return ask(env, step);
      case "notify": return notify(env, step);
      case "speak": return speak(env, step);
      case "clip": return clip(env, step);
      case "story": return story(env, step);
      case "wait": return wait(env, step, row);
      default:
        // Never reached for a checked definition: there is no other kind, and none that switches a device.
        return fail(`unknown step kind ${JSON.stringify((step as { kind?: unknown }).kind)}; nothing was done`);
    }
  }

  // --- a run ------------------------------------------------------------------------

  /** Runs one claimed run as far as it goes now. Returns quietly if the claim was lost (or the run cancelled). */
  async function execute(accountId: string, runId: string, token: string): Promise<void> {
    try {
      await executeHeld(accountId, runId, token);
    } catch (err) {
      if (err instanceof LostClaim) {
        deps.log?.warn({ run: runId }, "a workflow run was taken over or cancelled; this process stopped it");
        return;
      }
      throw err;
    }
  }

  async function executeHeld(accountId: string, runId: string, token: string): Promise<void> {
    const loaded = await data.withAccount(accountId, async (s) => {
      const run = await s.db.selectFrom("workflow_runs").selectAll().where("id", "=", runId).executeTakeFirst();
      if (!run || run.claim_token !== token) return undefined;
      const steps = await s.db.selectFrom("workflow_run_steps").selectAll().where("run_id", "=", runId).execute();
      const event = run.event_id ? await s.db.selectFrom("events").selectAll().where("id", "=", run.event_id).executeTakeFirst() : undefined;
      return { run, steps, event, account: await s.account.get(), sources: await s.sources.list() };
    });
    if (!loaded) return;
    const { run, event, account } = loaded;
    if (run.claims > MAX_TAKEOVERS) return finishRun(accountId, run, token, undefined, "failed", "the run was taken over too many times (its processes kept stopping); it was stopped", null);
    // The definition is checked again: a run follows only known step kinds (none switches a device) in a DAG.
    let def: WorkflowDefinition;
    try {
      def = checkDefinition(run.definition, run.source_ids);
    } catch (err) {
      const why = err instanceof DefinitionError ? err.message : "the definition couldn't be read";
      return finishRun(accountId, run, token, undefined, "failed", `the workflow's definition is invalid, so nothing ran: ${why}`, null);
    }
    if (run.event_id && !event) return finishRun(accountId, run, token, def, "failed", "the event that started this run no longer exists", null);
    const rows = new Map(loaded.steps.map((r) => [r.step_id, r]));
    const sources = new Map(loaded.sources.filter((x) => run.source_ids.includes(x.id)).map((x) => [x.id, x]));
    const trigger = run.trigger;
    const startedAt = new Date(run.created_at).getTime();
    const ctx: RunContext = {
      ...(event ? { event: eventContext(event, sources.get(event.source_id)?.name ?? event.source_id) } : {}),
      ...(trigger.type === "webhook" && trigger.input ? { input: trigger.input } : trigger.type === "manual" && trigger.input ? { input: trigger.input } : {}),
      steps: Object.fromEntries([...rows].filter(([, r]) => r.status === "succeeded" && r.output).map(([id, r]) => [id, r.output!])),
      at: startedAt, timeZone: account?.time_zone || "UTC",
    };
    const moment = event
      ? { from: new Date(event.occurred_at).getTime(), to: event.ended_at ? new Date(event.ended_at).getTime() : new Date(event.occurred_at).getTime() }
      : { from: startedAt, to: startedAt };
    const taken = (from: string, branch?: string) => {
      if (from === "trigger") return true;
      const r = rows.get(from);
      return r?.status === "succeeded" && (!branch || (r.output as { branch?: string } | null)?.branch === branch);
    };

    for (const step of order(def)) {
      const row = rows.get(step.id);
      if (row && (row.status === "succeeded" || row.status === "skipped")) continue;
      if (row?.status === "failed") return finishRun(accountId, run, token, def, "failed", row.error, step.id);
      // The workflow as it is now: deleted or turned off stops the run; it may have lost sources or speak steps since.
      const now = await data.withAccount(accountId, async (s) => ({
        workflow: run.workflow_id ? await s.db.selectFrom("workflows").select(["enabled", "source_ids", "definition"]).where("id", "=", run.workflow_id).executeTakeFirst() : undefined,
        list: await s.sources.list(), account: await s.account.get(), clock: await dbNow(s.db),
      }));
      if (!now.workflow) return finishRun(accountId, run, token, def, "cancelled", "the workflow was deleted, so the run was stopped", null);
      if (!now.workflow.enabled) return finishRun(accountId, run, token, def, "cancelled", "the workflow was turned off, so the run was stopped", null);
      if (!def.edges.some((e) => e.to === step.id && taken(e.from, e.branch))) {
        await guarded(accountId, run.id, token, (s) => putStep(s, run.id, step, { status: "skipped" }));
        rows.set(step.id, { ...(row ?? {} as StepRow), status: "skipped" });
        continue;
      }
      const clock = now.clock.getTime();
      if (row?.status === "waiting" && row.resume_at && new Date(row.resume_at).getTime() > clock) return park(accountId, run.id, token, { at: new Date(row.resume_at) });
      if (row?.status === "running" && (!RETRY_SAFE.has(step.kind) || row.attempts >= LIMITS.attempts)) {
        // The process running it stopped part way: a step that may not run twice is not run again.
        const error = "the step was interrupted (the process running it stopped), so it may or may not have happened; it isn't run twice";
        await guarded(accountId, run.id, token, (s) => putStep(s, run.id, step, { status: "failed", error, finished_at: sql`now()` as never }));
        return finishRun(accountId, run, token, def, "failed", error, step.id);
      }
      if (!(await renew(accountId, run.id, token))) throw new LostClaim();
      const attempts = (row?.attempts ?? 0) + 1;
      await guarded(accountId, run.id, token, (s) => putStep(s, run.id, step, { status: "running", attempts, started_at: (row?.started_at ?? sql`now()`) as never, error: null }));
      // Sources and grants as they are now: only sources the run and the workflow both still name; a camera whose
      // blurring was turned on is blurred from the next step.
      const allowed = new Map(now.list.filter((x) => run.source_ids.includes(x.id) && now.workflow!.source_ids.includes(x.id)).map((x) => [x.id, x]));
      const access = workflowAccess(run.workflow_id!, [...allowed.values()], now.account, def, now.workflow.definition);
      const env: StepEnv = { accountId, run, token, def, ctx, ...(event ? { event } : {}), sources: allowed, access, req: asRequest(accountId, access), moment, now: clock };
      const keep = setInterval(() => void renew(accountId, run.id, token).catch(() => undefined), (RUN_LEASE_S * 1000) / 4);
      let out: Outcome;
      try {
        out = await runStep(env, step, row);
      } catch (err) {
        if (err instanceof LostClaim) throw err;
        deps.log?.warn({ err, run: run.id, step: step.id }, "a workflow step failed");
        out = fail((err as Error).message || "the step failed", RETRY_SAFE.has(step.kind));
      } finally {
        clearInterval(keep);
      }
      if (out.status === "succeeded") {
        await guarded(accountId, run.id, token, (s) => putStep(s, run.id, step, { status: "succeeded", output: out.output, error: null, finished_at: sql`now()` as never, resume_at: null }));
        rows.set(step.id, { ...(row ?? {} as StepRow), step_id: step.id, status: "succeeded", output: out.output, attempts });
        ctx.steps[step.id] = out.output;
        continue;
      }
      if (out.status === "waiting") {
        // Waiting for the recording isn't an attempt.
        await guarded(accountId, run.id, token, (s) => putStep(s, run.id, step, { status: "waiting", resume_at: inSecs(out.afterS), attempts: out.attempt === false ? attempts - 1 : attempts, ...(out.output ? { output: out.output } : {}) }));
        return park(accountId, run.id, token, { afterS: out.afterS });
      }
      if (out.retry && RETRY_SAFE.has(step.kind) && attempts < LIMITS.attempts) {
        const afterS = RETRY_DELAYS_S[Math.min(attempts - 1, RETRY_DELAYS_S.length - 1)]!;
        await guarded(accountId, run.id, token, (s) => putStep(s, run.id, step, { status: "waiting", resume_at: inSecs(afterS), error: out.error }));
        return park(accountId, run.id, token, { afterS });
      }
      await guarded(accountId, run.id, token, (s) => putStep(s, run.id, step, { status: "failed", error: out.error, finished_at: sql`now()` as never }));
      return finishRun(accountId, run, token, def, "failed", out.error, step.id);
    }
    await finishRun(accountId, run, token, def, "succeeded", null, null);
  }

  // --- claiming ---------------------------------------------------------------------

  const claim = async (max: number, at?: Date) =>
    (await sql<{ id: string; account_id: string; token: string }>`select * from claim_workflow_runs(${max}, ${RUN_LEASE_S}, ${at ?? sql`now()`})`.execute(data.db())).rows;

  /** Claims and runs what is due (tests call this; the worker does it on a timer). Returns how many it ran. */
  async function runDue(max = 20): Promise<number> {
    const rows = await claim(max);
    for (const r of rows) await execute(r.account_id, r.id, r.token);
    return rows.length;
  }

  /**
   * Scheduled workflows that are due: a run each, and the next time worked out from the database's clock
   * (or `at`, standing in for it in tests). Returns how many it started.
   */
  async function fireSchedules(at?: Date, max = 50): Promise<number> {
    const due = (await sql<{ account_id: string; id: string }>`select * from claim_workflow_schedules(${max}, ${60}, ${at ?? sql`now()`})`.execute(data.db())).rows;
    let n = 0;
    for (const d of due) {
      await data.withAccount(d.account_id, async (s) => {
        const w = await s.db.selectFrom("workflows").selectAll().where("id", "=", d.id).executeTakeFirst();
        if (!w) return;
        const tz = (await s.account.get())?.time_zone || "UTC";
        const clock = at ?? (await dbNow(s.db));
        const out = await startRun(s, w.id, { type: "schedule", scheduled_for: (w.next_fire_at ? new Date(w.next_fire_at) : clock).toISOString() });
        if ("run" in out) n++;
        await s.db.updateTable("workflows").set({
          next_fire_at: nextFireAt(w.definition.trigger as ScheduleTrigger, tz, clock, true), fire_claimed_until: null, last_fired_at: clock,
        }).where("id", "=", w.id).execute();
      });
    }
    return n;
  }

  /** A person stops a run (POST /v1/workflow-runs/{id}/cancel): a process running it stops at its next write. */
  async function cancel(accountId: string, runId: string, by: string): Promise<WorkflowRunRow | undefined> {
    const out = await data.withAccount(accountId, async (s) => {
      const run = await s.db.selectFrom("workflow_runs").selectAll().where("id", "=", runId).forUpdate().executeTakeFirst();
      if (!run || run.due_at === null) return run ? { run, done: true } : undefined;
      await s.db.updateTable("workflow_run_steps").set({ status: "skipped", resume_at: null }).where("run_id", "=", runId).where("status", "in", ["waiting"]).execute();
      const have = new Set((await s.db.selectFrom("workflow_run_steps").select("step_id").where("run_id", "=", runId).execute()).map((r) => r.step_id));
      for (const st of run.definition.steps) if (!have.has(st.id)) await putStep(s, runId, st, { status: "skipped" });
      const row = await s.db.updateTable("workflow_runs").set({
        status: "cancelled", error: `cancelled by ${by}`, finished_at: sql`now()`, due_at: null, claimed_until: null, claim_token: null,
      }).where("id", "=", runId).returningAll().executeTakeFirstOrThrow();
      return { run: row, done: false };
    });
    if (!out) return undefined;
    if (out.done) throw new ApiError(409, "conflict", `this run has already ${out.run.status === "succeeded" ? "finished" : out.run.status}`);
    await audit(accountId, out.run, "cancelled", out.run.error);
    return out.run;
  }

  return { execute, runDue, fireSchedules, claim, cancel };
}

export type WorkflowEngine = ReturnType<typeof createWorkflowEngine>;

/** When a schedule is next due after `now` (the watch rules: an `at` on an allowed day, or `every_min` on). */
export function nextFireAt(t: ScheduleTrigger, accountTz: string, now: Date, ran: boolean): Date {
  const tz = t.time_zone || accountTz || "UTC";
  const trig = { type: "condition", ...(t.at ? { at: t.at } : { every_min: t.every_min ?? 60 }), ...(t.days?.length ? { days: t.days } : {}) } as Parameters<typeof nextCheck>[0];
  return new Date(nextCheck(trig, tz, null, ran ? now.getTime() : null, now.getTime(), ran));
}

/** The database's clock (ADR 0058). */
export const dbNow = async (db: Kysely<Database>): Promise<Date> =>
  new Date((await sql<{ now: Date }>`select now() as now`.execute(db)).rows[0]!.now);

/**
 * The workspace's time zone changed: schedules that follow it (no zone of their own) are worked out again
 * in the new zone, from now. Called in the account's update transaction.
 */
export async function rescheduleWorkflows(s: AccountScope, timeZone: string): Promise<number> {
  const rows = await s.db.selectFrom("workflows").select(["id", "definition"])
    .where("trigger_type", "=", "schedule").where("enabled", "=", true).where("next_fire_at", "is not", null).execute();
  const now = await dbNow(s.db);
  let n = 0;
  for (const w of rows) {
    const t = w.definition.trigger as ScheduleTrigger;
    if (t.time_zone) continue;
    await s.db.updateTable("workflows").set({ next_fire_at: nextFireAt(t, timeZone, now, false) }).where("id", "=", w.id).execute();
    n++;
  }
  return n;
}

/** The workflow worker: due runs (woken when a run is queued here) and due schedules. */
export function startWorkflowWorker(engine: WorkflowEngine, log: FastifyBaseLogger, intervalMs = 1000) {
  const runs = startClaimLoop({
    name: "workflows", intervalMs, log, kick: workflowKick, batch: 10,
    claim: (max) => engine.claim(max),
    handle: (r) => engine.execute(r.account_id, r.id, r.token),
  });
  const schedules = startClaimLoop({
    name: "workflow-schedules", intervalMs: 5000, log, batch: 50,
    claim: async () => [await engine.fireSchedules()],
    handle: async () => undefined,
  });
  return async () => {
    await runs();
    await schedules();
  };
}

/** Finished runs past their keeping time (a housekeeping job). */
export async function pruneWorkflowRuns(data: DataAccess, days: number = LIMITS.runDays): Promise<number> {
  return (await sql<{ prune_workflow_runs: number }>`select prune_workflow_runs(${days})`.execute(data.db())).rows[0]?.prune_workflow_runs ?? 0;
}
