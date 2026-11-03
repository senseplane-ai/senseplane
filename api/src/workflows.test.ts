// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Workflows (ADR 0072) against a real database: admins make them, agents
// can't reach them; events, schedules, signed webhooks and people start runs;
// steps tell (signed webhooks, chats), ask, speak, clip, make stories and
// wait, as a principal limited to the workflow's sources with the grant and
// privacy rules of an agent; runs are recorded per step; the run rate holds;
// a lost claim writes nothing; speech is never run twice; and nothing a
// workflow does, or could be made to do, switches a device.
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEvent } from "./events.js";
import { type ApiBus, createApi, type SenseplaneApi } from "./index.js";
import { newId } from "./data/ids.js";
import { createPasswordUser } from "./routes/auth.js";
import { requiredRole } from "./roles.js";
import { encodeWav } from "./speak.js";
import type { ObjectStorage } from "./storage.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";
import type { EgressRequest } from "./egress.js";
import { createWorkflowEngine, workflowAccess } from "./workflows.js";

const PW = "correct horse battery";
const log = { warn() {}, error() {}, info() {} } as never;

describe("workflows", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let owner: string;
  let admin: string;
  let member: string;
  let viewer: string;
  let agentKey: string;
  let porch: string;
  let garden: string;
  let elsewhere: string;
  let sensor: string;
  let hook: { id: string; secret: string };
  let chat: string;
  const plane = fakeMediaPlane();
  const objects = new Map<string, Buffer>();
  const storage = {
    async put(key: string, body: Uint8Array) { objects.set(key, Buffer.from(body)); },
    async copy() {}, async deleteMany(keys: string[]) { keys.forEach((k) => objects.delete(k)); return keys.length; }, async deletePrefix() { return 0; },
    async presign() { return undefined; }, async presignPut() { return "http://bucket.test/put"; },
    async get(key: string) { const b = objects.get(key) ?? Buffer.alloc(0); return { body: Readable.from([b]), length: b.length }; },
  } as unknown as ObjectStorage;
  /** What the brain was asked, and how it answers: yes when the question mentions a parcel. */
  const asked: { subject: string; payload: Record<string, unknown> }[] = [];
  let brainDown = false;
  const bus: ApiBus = {
    async putSourceConfig() {}, async latestSnapshot() { return undefined; }, async putWatch() {}, async close() {},
    async supports() { return true; },
    async request<T>(subject: string, payload: unknown): Promise<T> {
      asked.push({ subject, payload: payload as Record<string, unknown> });
      if (brainDown) throw new Error("timeout");
      const q = String((payload as { prompt?: string; question?: string }).prompt ?? (payload as { question?: string }).question ?? "");
      if (subject === "rpc.brain.check") return { yes: /parcel/.test(q), answer: /parcel/.test(q) ? "Yes, a brown box." : "No.", confidence: 0.9 } as T;
      if (subject === "rpc.brain.ask") return { error: "no_live_frame" } as T;
      if (subject === "rpc.brain.compile") return { compiled: { trigger: { type: "objects", label: "person", on: "enter" }, cooldown_s: 0, active_hours: null }, estimate: { vlm_calls_per_day: "0" }, warnings: [], compiler: "rules", needs_zone: false } as T;
      throw new Error(subject);
    },
  };
  /** Webhook POSTs a workflow sent, and what the receiver answers next (200 unless queued). */
  const sent: { url: string; req: EgressRequest }[] = [];
  const answers: (number | Error)[] = [];
  const sender = async (url: string, req: EgressRequest) => {
    sent.push({ url, req });
    const a = answers.shift() ?? 200;
    if (a instanceof Error) throw a;
    return { status: a };
  };
  const tts = (async (_url: string | URL, init?: RequestInit) => {
    const text = String(JSON.parse(String(init?.body ?? "{}")).input);
    return new Response(new Uint8Array(encodeWav({ rate: 24_000, samples: new Int16Array(Math.min(24_000, 2400 + text.length * 10)) })), { headers: { "content-type": "audio/wav" } });
  }) as typeof fetch;

  const call = (key: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const create = async (body: Record<string, unknown>, key = owner) => {
    const r = await call(key, "POST", "/v1/workflows", { name: "Door", sources: [porch, garden, sensor], ...body });
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  };
  let n = 0;
  const event = (source: string, extra: Record<string, unknown> = {}) => api.data.withAccount(acc, (s) => createEvent(s, {
    event_key: `wf-${++n}`, source_id: source, type: "detection.person", sense: "video", occurred_at: new Date(Date.now() - 60_000),
    summary: "Someone at the door", labels: ["person"], confidence: 0.9, snapshot_key: `snapshots/${acc}/${source}/e${n}.jpg`, ...extra,
  }));
  const runsOf = async (id: string) => (await call(owner, "GET", `/v1/workflows/${id}/runs`)).json().data as { id: string; status: string; error: string | null }[];
  const runOf = async (id: string) => (await call(owner, "GET", `/v1/workflow-runs/${id}`)).json();
  const stepsOf = async (runId: string) => Object.fromEntries(((await runOf(runId)).steps as { id: string; status: string }[]).map((s) => [s.id, s.status]));
  /** Everything waiting is due now. */
  const due = () => api.data.withAccount(acc, async (s) => {
    await s.db.updateTable("workflow_runs").set({ due_at: new Date(Date.now() - 1000) }).where("due_at", "is not", null).execute();
    await s.db.updateTable("workflow_run_steps").set({ resume_at: new Date(Date.now() - 1000) }).where("status", "=", "waiting").execute();
  });
  const clearRuns = () => api.data.withAccount(acc, async (s) => {
    await s.db.deleteFrom("workflow_runs").execute();
    await s.db.deleteFrom("workflows").execute();
    await s.db.deleteFrom("speak_messages").execute();
  });
  const sign = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const hookCall = (id: string, body: string, signature?: string) => api.public.inject({
    method: "POST", url: `/v1/workflow-hooks/${id}`, payload: body, headers: { "content-type": "application/json", ...(signature ? { "senseplane-signature": signature } : {}) },
  });

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", bus, storage, apiPublicUrl: "https://api.test",
      media: { control: plane.client, publicUrl: "https://media.test" }, workflowSender: sender,
      auth: { signupOpen: false, password: true, consoleUrls: ["https://console.test"], sessionDays: 30, inviteDays: 7, attemptsPerMinute: 1000 } as never,
      tts: { baseUrl: "http://tts.test/v1", model: "kokoro", voice: "af_heart", fetch: tts }, speakTimings: { takeMs: 1000 },
    });
    acc = (await api.data.accounts.create("Home")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    const login = async (email: string, role: "admin" | "member" | "viewer") => {
      await createPasswordUser(api.data, acc, email, PW, role);
      return (await api.public.inject({ method: "POST", url: "/auth/login", payload: { email, password: PW } })).json().session as string;
    };
    admin = await login("ada@example.test", "admin");
    member = await login("sam@example.test", "member");
    viewer = await login("vic@example.test", "viewer");
    porch = (await call(owner, "POST", "/v1/sources", { name: "Porch phone", type: "browser" })).json().id;
    garden = (await call(owner, "POST", "/v1/sources", { name: "Garden", type: "whip" })).json().id;
    elsewhere = (await call(owner, "POST", "/v1/sources", { name: "Office", type: "browser" })).json().id;
    sensor = (await call(owner, "POST", "/v1/sources", { name: "Hall sensor", type: "sensor" })).json().id;
    plane.publish(porch);
    const agent = (await call(owner, "POST", "/v1/agents", { name: "Helper" })).json();
    agentKey = agent.api_key;
    await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [porch, garden], senses: ["video", "audio", "sensors", "control", "speak"] });
    const h = (await call(owner, "POST", "/v1/webhooks", { url: "https://n8n.example.com/webhook/door", events: ["watch.triggered"] })).json();
    hook = { id: h.id, secret: h.secret };
    chat = newId("chn");
    await api.data.withAccount(acc, (s) => s.db.insertInto("channels").values({
      id: chat, account_id: acc, kind: "telegram", chat_id: "4242", chat_type: "private", name: "Family", agent_id: agent.id, agent_key: api.data.box().encrypt("sk_x"),
    }).execute());
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });
  beforeEach(async () => {
    await clearRuns();
    sent.length = 0;
    answers.length = 0;
    asked.length = 0;
    brainDown = false;
  });

  const doorFlow = () => ({
    trigger: { type: "event", event_types: ["detection.*"], sources: [porch] },
    steps: [
      { id: "night", kind: "condition", rules: [{ field: "event.labels", op: "contains", value: "person" }] },
      { id: "parcel", kind: "ask", question: "Is someone carrying a parcel?" },
      { id: "say", kind: "speak", source: porch, text: "Please leave the parcel by the gate." },
      { id: "tell", kind: "notify", to: { type: "webhook", id: hook.id }, text: "{{event.source_name}}: {{event.summary}} ({{steps.parcel.answer}})" },
      { id: "family", kind: "notify", to: { type: "channel", id: chat }, text: "Someone with no parcel: {{event.summary}}" },
    ],
    edges: [
      { from: "trigger", to: "night" },
      { from: "night", to: "parcel", branch: "yes" },
      { from: "parcel", to: "say", branch: "yes" },
      { from: "parcel", to: "tell", branch: "yes" },
      { from: "parcel", to: "family", branch: "no" },
    ],
  });

  describe("who may", () => {
    it("lets admins and workspace keys make them, everyone in the workspace read them, and no agent near them", async () => {
      for (const route of ["POST /v1/workflows", "PATCH /v1/workflows/:id", "DELETE /v1/workflows/:id", "POST /v1/workflows/:id/run", "POST /v1/workflows/:id/hook-secret"]) {
        const [m, u] = route.split(" ");
        expect(requiredRole(m!, u)).toBe("admin");
      }
      expect(requiredRole("GET", "/v1/workflows")).toBe("viewer");
      const body = { name: "Door", sources: [porch], ...doorFlow() };
      for (const key of [member, viewer]) {
        const r = await call(key, "POST", "/v1/workflows", body);
        expect(r.statusCode).toBe(403);
        expect(r.json().error.code).toBe("forbidden_role");
      }
      const made = await call(admin, "POST", "/v1/workflows", body);
      expect(made.statusCode, made.body).toBe(201);
      const wf = made.json();
      expect(wf).toMatchObject({ name: "Door", enabled: true, sources: [porch], runs_dropped: 0, created_by: expect.stringMatching(/^user:/) });
      expect(wf.id).toMatch(/^wfl_/);
      expect((await call(viewer, "GET", `/v1/workflows/${wf.id}`)).json().id).toBe(wf.id);
      expect((await call(member, "GET", "/v1/workflows")).json().data).toHaveLength(1);
      expect((await call(viewer, "PATCH", `/v1/workflows/${wf.id}`, { enabled: false })).statusCode).toBe(403);
      // Agents: not even reading.
      for (const [m, u] of [["GET", "/v1/workflows"], ["POST", "/v1/workflows"], ["GET", `/v1/workflows/${wf.id}/runs`], ["POST", `/v1/workflows/${wf.id}/run`]] as const) {
        const r = await call(agentKey, m, u, m === "POST" ? body : undefined);
        expect(r.statusCode).toBe(403);
        expect(r.json().error.code).toBe("forbidden");
      }
      expect((await call(owner, "DELETE", `/v1/workflows/${wf.id}`)).statusCode).toBe(204);
    });

    it("refuses at save time what can't run: a control step, a cycle, unknown or outside things", async () => {
      const bad = async (patch: (b: ReturnType<typeof doorFlow>) => unknown, match: RegExp, sources = [porch]) => {
        const b = doorFlow();
        patch(b);
        const r = await call(owner, "POST", "/v1/workflows", { name: "Bad", sources, ...b });
        expect(r.statusCode, r.body).toBe(400);
        expect(r.json().error.code).toBe("validation_failed");
        expect(r.json().error.message).toMatch(match);
      };
      await bad((b) => { (b.steps as unknown[]).push({ id: "flip", kind: "control", device: "dev_1", action: "unlock" }); b.edges.push({ from: "night", to: "flip", branch: "no" }); },
        /unknown step kind "control".*No step switches a device/);
      await bad((b) => b.edges.push({ from: "tell", to: "night" }), /can't have a cycle/);
      await bad((b) => { b.steps[2] = { id: "say", kind: "speak", source: elsewhere, text: "hi" }; }, /isn't one of the workflow's sources/);
      await bad(() => undefined, /unknown sources: src_nope/, [porch, "src_nope"]);
      await bad((b) => { b.steps[3] = { ...b.steps[3]!, to: { type: "webhook", id: "whk_nope" } } as never; }, /no webhook whk_nope/);
      await bad((b) => { b.steps[2] = { id: "say", kind: "speak", source: garden, text: "hi" }; }, /Garden has no speaker/, [porch, garden]);
      await bad((b) => { b.trigger = { type: "schedule", every_min: 10, time_zone: "Mars/Olympus" } as never; b.steps = [b.steps[3]!] as never; b.edges = [{ from: "trigger", to: "tell" }]; }, /isn't an IANA time zone/);
      expect((await call(owner, "GET", "/v1/workflows")).json().data).toHaveLength(0);
    });
  });

  describe("runs", () => {
    it("starts on an event on its sources, follows the branches and records every step", async () => {
      const wf = await create({ name: "Door", sources: [porch], ...doorFlow() });
      // Another camera, a type it doesn't take, and a source it doesn't name never start it.
      await event(garden);
      await event(elsewhere);
      await event(porch, { type: "sound.dog_bark", sense: "audio" });
      expect(await runsOf(wf.id)).toHaveLength(0);
      const ev = await event(porch);
      const [queued] = await runsOf(wf.id);
      expect(queued).toMatchObject({ status: "queued" });
      expect(await api.workflows.runDue()).toBe(1);
      const run = await runOf(queued!.id);
      expect(run.status, run.error).toBe("succeeded");
      expect(run.trigger).toEqual({ type: "event", event_id: ev!.id, event_type: "detection.person" });
      expect(Object.fromEntries(run.steps.map((s: { id: string; status: string }) => [s.id, s.status]))).toEqual({ night: "succeeded", parcel: "succeeded", say: "succeeded", tell: "succeeded", family: "skipped" });
      const parcel = run.steps.find((s: { id: string }) => s.id === "parcel");
      expect(parcel).toMatchObject({ attempts: 1, output: { branch: "yes", yes: true, answer: "Yes, a brown box." }, started_at: expect.any(String), finished_at: expect.any(String) });
      // The ask looked at the event's own snapshot, as the workflow (purpose workflow).
      expect(asked.find((a) => a.subject === "rpc.brain.check")!.payload).toMatchObject({ account_id: acc, source_id: porch, prompt: "Is someone carrying a parcel?", purpose: "workflow" });
      // Said through the porch phone, as the workflow.
      const said = (await call(owner, "GET", "/v1/speak-messages")).json().data[0];
      expect(said).toMatchObject({ source_id: porch, kind: "workflow", text: "Please leave the parcel by the gate.", requested_by: { kind: "workflow", id: wf.id, name: "Workflow: Door" } });
      expect(plane.spoken.at(-1)).toMatchObject({ room: `sp-${porch}`, id: said.id });
      expect(run.definition.steps.map((s: { id: string }) => s.id)).toEqual(["night", "parcel", "say", "tell", "family"]);
    });

    it("signs its webhook like every Senseplane webhook, with a delivery id that is the same on a retry", async () => {
      const wf = await create({ name: "Door", sources: [porch], ...doorFlow() });
      answers.push(503);
      await event(porch);
      await api.workflows.runDue();
      const [run] = await runsOf(wf.id);
      expect(run!.status).toBe("waiting");
      expect((await runOf(run!.id)).steps.find((s: { id: string }) => s.id === "tell")).toMatchObject({ status: "waiting", attempts: 1, error: expect.stringContaining("503"), resumes_at: expect.any(String) });
      // Not due yet: nothing happens.
      expect(await api.workflows.runDue()).toBe(0);
      await due();
      await api.workflows.runDue();
      const done = await runOf(run!.id);
      expect(done.status).toBe("succeeded");
      expect(done.steps.find((s: { id: string }) => s.id === "tell")).toMatchObject({ status: "succeeded", attempts: 2, output: { status_code: 200 } });
      // The speech before it isn't said again on the retry.
      expect((await call(owner, "GET", "/v1/speak-messages")).json().data).toHaveLength(1);
      expect(sent).toHaveLength(2);
      for (const { url, req } of sent) {
        expect(url).toBe("https://n8n.example.com/webhook/door");
        const sig = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers["senseplane-signature"]!)!;
        expect(createHmac("sha256", hook.secret).update(`${sig[1]}.${req.body}`).digest("hex")).toBe(sig[2]);
        expect(req.headers["senseplane-event"]).toBe("workflow.notify");
        expect(req.headers["senseplane-delivery"]).toBe(`${run!.id}.tell`);
        const body = JSON.parse(req.body);
        expect(body).toMatchObject({ type: "workflow.notify", id: `${run!.id}.tell`, workflow: { id: wf.id, name: "Door" }, run_id: run!.id, step_id: "tell",
          text: "Porch phone: Someone at the door (Yes, a brown box.)", event: { type: "detection.person", source: { id: porch, name: "Porch phone" } } });
      }
      // A wrong secret doesn't verify.
      const s0 = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sent[0]!.req.headers["senseplane-signature"]!)!;
      expect(createHmac("sha256", "whsec_wrong").update(`${s0[1]}.${sent[0]!.req.body}`).digest("hex")).not.toBe(s0[2]);
    });

    it("fails clearly: a receiver's refusal isn't retried, and three failures end the run", async () => {
      const wf = await create({ name: "Door", sources: [porch], ...doorFlow() });
      answers.push(400);
      await event(porch);
      await api.workflows.runDue();
      const [run] = await runsOf(wf.id);
      const r = await runOf(run!.id);
      expect(r).toMatchObject({ status: "failed", failed_step: "tell", error: expect.stringContaining("400") });
      expect(sent).toHaveLength(1);
      // Network errors are retried, at most three attempts in all.
      await clearRuns();
      sent.length = 0;
      const wf2 = await create({ name: "Door", sources: [porch], ...doorFlow() });
      answers.push(new Error("connect ECONNREFUSED"), new Error("connect ECONNREFUSED"), new Error("connect ECONNREFUSED"));
      await event(porch);
      for (let i = 0; i < 3; i++) {
        await api.workflows.runDue();
        await due();
      }
      const [run2] = await runsOf(wf2.id);
      const r2 = await runOf(run2!.id);
      expect(r2.status).toBe("failed");
      expect(r2.steps.find((s: { id: string }) => s.id === "tell")).toMatchObject({ status: "failed", attempts: 3 });
      expect(sent).toHaveLength(3);
    });

    it("tells a linked chat when the answer is no, and an event's snapshot goes with it", async () => {
      const wf = await create({ name: "Door", sources: [porch], ...doorFlow() });
      await api.data.withAccount(acc, (s) => s.db.updateTable("workflows").set({
        definition: JSON.stringify({ ...doorFlow(), steps: doorFlow().steps.map((s) => (s.id === "parcel" ? { ...s, question: "Is it raining?" } : s)) }),
      }).where("id", "=", wf.id).execute());
      await event(porch);
      await api.workflows.runDue();
      const [run] = await runsOf(wf.id);
      expect(await stepsOf(run!.id)).toEqual({ night: "succeeded", parcel: "succeeded", say: "skipped", tell: "skipped", family: "succeeded" });
      const msg = await api.data.withAccount(acc, (s) => s.db.selectFrom("channel_messages").selectAll().where("channel_id", "=", chat).orderBy("created_at", "desc").executeTakeFirstOrThrow());
      expect(msg.body).toMatchObject({ text: "<b>Door</b>\nSomeone with no parcel: Someone at the door", photo_key: expect.stringContaining(porch), photo_source: porch });
    });
  });

  describe("privacy and grants, as an agent would have them", () => {
    it("blurs what it asks and sends no snapshot from a blurred camera, and won't clip or make a story of it", async () => {
      await call(owner, "PATCH", `/v1/sources/${porch}`, { blur_faces: true });
      try {
        const flow = doorFlow();
        flow.steps[1] = { id: "parcel", kind: "ask", question: "Is it raining?" };
        const wf = await create({
          name: "Blurred", sources: [porch],
          trigger: flow.trigger,
          steps: [flow.steps[1]!, flow.steps[4]!, { id: "keep", kind: "clip" }],
          edges: [{ from: "trigger", to: "parcel" }, { from: "parcel", to: "family", branch: "no" }, { from: "family", to: "keep" }],
        });
        await event(porch);
        await api.workflows.runDue();
        const [run] = await runsOf(wf.id);
        const r = await runOf(run!.id);
        expect(asked.find((a) => a.subject === "rpc.brain.check")!.payload.blur).toEqual({ faces: true, plates: true });
        const msg = await api.data.withAccount(acc, (s) => s.db.selectFrom("channel_messages").selectAll().where("channel_id", "=", chat).orderBy("created_at", "desc").executeTakeFirstOrThrow());
        expect(msg.body?.photo_key).toBeUndefined();
        expect(r).toMatchObject({ status: "failed", failed_step: "keep", error: expect.stringContaining("blurred for this workflow") });
        // A story of it is refused the same way (recordings aren't blurred).
        const st = await create({ name: "Story", sources: [porch], trigger: flow.trigger, steps: [{ id: "tale", kind: "story" }], edges: [{ from: "trigger", to: "tale" }] });
        await event(porch);
        await api.workflows.runDue();
        const [srun] = await runsOf(st.id);
        expect(await runOf(srun!.id)).toMatchObject({ status: "failed", error: expect.stringContaining("only blurred") });
      } finally {
        await call(owner, "PATCH", `/v1/sources/${porch}`, { blur_faces: null });
      }
    });

    it("clips the event's moment once it is recorded, and makes stories as the workflow", async () => {
      const at = Date.now() - 60_000;
      await api.data.withAccount(acc, (s) => s.db.insertInto("segments").values([0, 1, 2, 3].map((i) => ({
        account_id: acc, source_id: porch, key: `seg/${porch}/${at}-${i}.m4s`, init_key: `seg/${porch}/init.mp4`, start_at: new Date(at - 10_000 + i * 6000), duration_ms: 6000, bytes: 1000, codec: "avc1",
      }))).execute());
      const wf = await create({ name: "Keep", sources: [porch], trigger: { type: "event", sources: [porch] },
        steps: [{ id: "keep", kind: "clip", before_s: 5, after_s: 5 }, { id: "tale", kind: "story", before_s: 5, after_s: 5, mode: "fast" }],
        edges: [{ from: "trigger", to: "keep" }, { from: "keep", to: "tale" }] });
      await event(porch, { occurred_at: new Date(at) });
      await api.workflows.runDue();
      const [run] = await runsOf(wf.id);
      const r = await runOf(run!.id);
      expect(r.status, r.error).toBe("succeeded");
      const clipId = r.steps[0].output.clip_id;
      expect(clipId).toMatch(/^clp_/);
      const storyId = r.steps[1].output.story_id;
      const story = await api.data.withAccount(acc, (s) => s.db.selectFrom("stories").selectAll().where("id", "=", storyId).executeTakeFirstOrThrow());
      expect(story).toMatchObject({ created_by: `workflow:${wf.id}`, mode: "fast" });
      // An event just now: the clip waits for its recording, and that isn't an attempt.
      await event(porch, { occurred_at: new Date() });
      await api.workflows.runDue();
      const [later] = await runsOf(wf.id);
      expect(later!.status).toBe("waiting");
      expect((await runOf(later!.id)).steps[0]).toMatchObject({ id: "keep", status: "waiting", attempts: 0 });
    });

    it("never reaches beyond its sources, nor speaks without a speak step naming the camera", async () => {
      // An ask on a camera of the account that isn't the workflow's is refused at save time; one sneaked in fails at run time.
      const wf = await create({ name: "Look", sources: [porch], trigger: { type: "webhook" }, steps: [{ id: "look", kind: "ask", question: "Anyone there?", source: porch }], edges: [{ from: "trigger", to: "look" }] });
      await api.data.withAccount(acc, (s) => s.db.updateTable("workflows").set({ source_ids: [porch, elsewhere], definition: JSON.stringify({
        trigger: { type: "webhook" }, steps: [{ id: "look", kind: "ask", question: "Anyone there?", source: elsewhere }, { id: "say", kind: "speak", source: elsewhere, text: "hi" }],
        edges: [{ from: "trigger", to: "look" }, { from: "look", to: "say" }],
      }) }).where("id", "=", wf.id).execute());
      // The run keeps the sources the workflow named when it started, so widen it the same way for the run.
      const r = await call(owner, "POST", `/v1/workflows/${wf.id}/run`, { input: {} });
      expect(r.statusCode).toBe(202);
      await api.data.withAccount(acc, (s) => s.db.updateTable("workflow_runs").set({ source_ids: [porch] }).where("id", "=", r.json().id).execute());
      await api.workflows.runDue();
      expect(await runOf(r.json().id)).toMatchObject({ status: "failed", error: expect.stringContaining("isn't one of the workflow's sources") });
      expect(asked).toHaveLength(0);
    });
  });

  describe("the engine", () => {
    it("refuses to run a definition with any other step kind, even one written around the API, and never touches a device", async () => {
      const wf = await create({ name: "Hook", sources: [porch], trigger: { type: "webhook" }, steps: [{ id: "w", kind: "wait", seconds: 1 }], edges: [{ from: "trigger", to: "w" }] });
      const sneaky = { trigger: { type: "webhook" }, steps: [{ id: "flip", kind: "control", device: "dev_1", action: "unlock" }, { id: "tell", kind: "notify", to: { type: "webhook", id: hook.id }, text: "unlocked" }], edges: [{ from: "trigger", to: "flip" }, { from: "flip", to: "tell" }] };
      await api.data.withAccount(acc, (s) => s.db.updateTable("workflows").set({ definition: JSON.stringify(sneaky) }).where("id", "=", wf.id).execute());
      const r = await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {});
      expect(r.statusCode).toBe(202);
      await api.workflows.runDue();
      const run = await runOf(r.json().id);
      expect(run.status).toBe("failed");
      expect(run.error).toMatch(/definition is invalid, so nothing ran: .*unknown step kind "control"/);
      expect(run.steps).toEqual([]);
      expect(sent).toHaveLength(0);
      const commands = await api.data.withAccount(acc, async (s) => ({
        bridge: await s.db.selectFrom("bridge_commands").select("id").execute(),
        device: await s.db.selectFrom("device_commands").select("id").execute(),
      }));
      expect(commands).toEqual({ bridge: [], device: [] });
    });

    it("has no path to a device: no workflow file imports the device code or writes device commands", () => {
      const src = new URL("./", import.meta.url);
      const files = ["workflows.ts", "workflow-spec.ts", "workflow-queue.ts", "routes/workflows.ts"];
      for (const f of files) {
        const text = readFileSync(new URL(f, src), "utf8");
        expect(text, f).not.toMatch(/devices\.js|device_commands|device_control|\/v1\/devices|\.inject\(/);
      }
      // And only the device routes create device work, as ADR 0067 has it.
      const all = [...readdirSync(src), ...readdirSync(new URL("routes/", src)).map((f) => `routes/${f}`)].filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
      expect(all.filter((f) => /kind: "device_control"/.test(readFileSync(new URL(f, src), "utf8")))).toEqual(["routes/devices.ts"]);
    });

    it("stops writing when it loses its claim, and the process that took over finishes the run", async () => {
      const wf = await create({ name: "Hook", sources: [porch], trigger: { type: "webhook" },
        steps: [{ id: "tell", kind: "notify", to: { type: "webhook", id: hook.id }, text: "hello {{input.who}}" }], edges: [{ from: "trigger", to: "tell" }] });
      const engine = createWorkflowEngine({ data: api.data, send: sender, log });
      const r = await call(owner, "POST", `/v1/workflows/${wf.id}/run`, { input: { who: "Ada" } });
      const [first] = await engine.claim(5);
      expect(first!.id).toBe(r.json().id);
      // The first process stalls past its lease; another claims the run.
      await api.data.withAccount(acc, (s) => s.db.updateTable("workflow_runs").set({ claimed_until: new Date(Date.now() - 1000) }).where("id", "=", first!.id).execute());
      const [second] = await engine.claim(5);
      expect(second!.token).not.toBe(first!.token);
      await engine.execute(acc, first!.id, first!.token);
      expect(sent).toHaveLength(0);
      expect((await runOf(first!.id)).steps).toEqual([]);
      await engine.execute(acc, second!.id, second!.token);
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]!.req.body).text).toBe("hello Ada");
      expect((await runOf(first!.id)).status).toBe("succeeded");
      // A token from before can't finish anything later either.
      await engine.execute(acc, first!.id, first!.token);
      expect(sent).toHaveLength(1);
    });

    it("runs a retry-safe step again after a lost process, but never speech: that fails as maybe-said", async () => {
      const wf = await create({ name: "Say", sources: [porch], trigger: { type: "webhook" },
        steps: [{ id: "tell", kind: "notify", to: { type: "webhook", id: hook.id }, text: "x" }, { id: "say", kind: "speak", source: porch, text: "Hello there." }],
        edges: [{ from: "trigger", to: "tell" }, { from: "tell", to: "say" }] });
      const says: string[] = [];
      const speech = { say: async (_a: string, _s: unknown, _w: unknown, text: string) => { says.push(text); return { row: { id: "spk_test", status: "played" }, http: 200 } as never; } };
      const engine = createWorkflowEngine({ data: api.data, send: sender, log, speech });
      // A process died during the webhook: it is sent again.
      const r1 = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
      await api.data.withAccount(acc, (s) => s.db.insertInto("workflow_run_steps").values({ run_id: r1.id, step_id: "tell", account_id: acc, kind: "notify", status: "running", attempts: 1, started_at: new Date() }).execute());
      // And one died while speaking.
      await api.data.withAccount(acc, (s) => s.db.updateTable("workflow_runs").set({ claims: 1 }).where("id", "=", r1.id).execute());
      for (const c of await engine.claim(5)) await engine.execute(acc, c.id, c.token);
      expect(sent).toHaveLength(1);
      const r1done = await runOf(r1.id);
      expect(r1done.steps.find((s: { id: string }) => s.id === "tell")).toMatchObject({ status: "succeeded", attempts: 2 });
      expect(r1done.status, r1done.error).toBe("succeeded");
      expect(says).toEqual(["Hello there."]);
      const r2 = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
      await api.data.withAccount(acc, (s) => s.db.insertInto("workflow_run_steps").values([
        { run_id: r2.id, step_id: "tell", account_id: acc, kind: "notify", status: "succeeded", attempts: 1, output: JSON.stringify({ status_code: 200 }) },
        { run_id: r2.id, step_id: "say", account_id: acc, kind: "speak", status: "running", attempts: 1, started_at: new Date() },
      ]).execute());
      for (const c of await engine.claim(5)) await engine.execute(acc, c.id, c.token);
      const r2done = await runOf(r2.id);
      expect(r2done).toMatchObject({ status: "failed", failed_step: "say", error: expect.stringContaining("may or may not have happened") });
      expect(says).toEqual(["Hello there."]);
    });

    it("grants a run only its own sources: video and sensors, audio where the camera records it, speak where a step speaks, blurred where blurring is on", async () => {
      await call(owner, "PATCH", `/v1/sources/${garden}`, { record_audio: true, blur_plates: true });
      try {
        const list = await api.data.withAccount(acc, (s) => s.sources.list());
        const def = { trigger: { type: "webhook" as const }, steps: [{ id: "say", kind: "speak" as const, source: porch, text: "hi" }], edges: [{ from: "trigger", to: "say" }] };
        const access = workflowAccess("wfl_x", list.filter((s) => [porch, garden, sensor].includes(s.id)), await api.data.withAccount(acc, (s) => s.account.get()), def);
        expect(access.actor).toBe("workflow:wfl_x");
        const by = Object.fromEntries(access.grants!.map((g) => [g.source_ids[0], g]));
        expect(Object.keys(by).sort()).toEqual([porch, garden, sensor].sort());
        expect(by[porch]).toMatchObject({ senses: ["video", "sensors", "speak"], blurred_only: false });
        expect(by[garden]).toMatchObject({ senses: ["video", "audio", "sensors"], blurred_only: true });
        expect(by[sensor]).toMatchObject({ senses: ["sensors"], blurred_only: false });
        expect(access.grants!.flatMap((g) => g.senses)).not.toContain("control");
      } finally {
        await call(owner, "PATCH", `/v1/sources/${garden}`, { record_audio: false, blur_plates: null });
      }
    });

    it("asks within the account's AI checks, and tries again when the brain doesn't answer", async () => {
      const wf = await create({ name: "Ask", sources: [porch], trigger: { type: "event", sources: [porch] },
        steps: [{ id: "look", kind: "ask", question: "Is there a parcel?" }], edges: [{ from: "trigger", to: "look" }] });
      const usedUp = createWorkflowEngine({ data: api.data, bus, storage, send: sender, log, checksUsedUp: async () => true });
      await event(porch);
      for (const c of await usedUp.claim(5)) await usedUp.execute(acc, c.id, c.token);
      const [first] = await runsOf(wf.id);
      expect(await runOf(first!.id)).toMatchObject({ status: "failed", error: expect.stringContaining("allowance_exhausted") });
      expect(asked).toHaveLength(0);
      brainDown = true;
      await event(porch);
      await api.workflows.runDue();
      const [second] = await runsOf(wf.id);
      expect((await runOf(second!.id)).steps[0]).toMatchObject({ status: "waiting", attempts: 1, error: "the brain didn't answer" });
      brainDown = false;
      await due();
      await api.workflows.runDue();
      expect((await runOf(second!.id)).steps[0]).toMatchObject({ status: "succeeded", attempts: 2, output: { yes: true } });
    });

    it("waits without holding a claim, then goes on", async () => {
      const wf = await create({ name: "Later", sources: [porch], trigger: { type: "webhook" },
        steps: [{ id: "pause", kind: "wait", seconds: 600 }, { id: "tell", kind: "notify", to: { type: "webhook", id: hook.id }, text: "later" }],
        edges: [{ from: "trigger", to: "pause" }, { from: "pause", to: "tell" }] });
      const r = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
      await api.workflows.runDue();
      const waiting = await runOf(r.id);
      expect(waiting).toMatchObject({ status: "waiting", resumes_at: expect.any(String) });
      expect(Date.parse(waiting.resumes_at) - Date.now()).toBeGreaterThan(590_000);
      const row = await api.data.withAccount(acc, (s) => s.db.selectFrom("workflow_runs").select(["claimed_until", "claim_token"]).where("id", "=", r.id).executeTakeFirstOrThrow());
      expect(row).toEqual({ claimed_until: null, claim_token: null });
      expect(await api.workflows.runDue()).toBe(0);
      await due();
      await api.workflows.runDue();
      expect((await runOf(r.id)).status).toBe("succeeded");
      expect(sent).toHaveLength(1);
    });
  });

  describe("limits", () => {
    it("starts at most 10 runs a minute per workflow; the rest are dropped and counted", async () => {
      const wf = await create({ name: "Busy", sources: [porch], trigger: { type: "event", sources: [porch] }, steps: [{ id: "w", kind: "wait", seconds: 1 }], edges: [{ from: "trigger", to: "w" }] });
      for (let i = 0; i < 12; i++) await event(porch);
      expect(await runsOf(wf.id)).toHaveLength(10);
      expect((await call(owner, "GET", `/v1/workflows/${wf.id}`)).json().runs_dropped).toBe(2);
      // By hand too: 429.
      const hookWf = await create({ name: "Manual", sources: [porch], trigger: { type: "webhook" }, steps: [{ id: "w", kind: "wait", seconds: 1 }], edges: [{ from: "trigger", to: "w" }] });
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) codes.push((await call(owner, "POST", `/v1/workflows/${hookWf.id}/run`, {})).statusCode);
      expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
      expect(codes[10]).toBe(429);
    });

    it("keeps to 20 steps and 100 workflows a workspace", async () => {
      const steps = Array.from({ length: 21 }, (_, i) => ({ id: `w${i}`, kind: "wait", seconds: 1 }));
      const r = await call(owner, "POST", "/v1/workflows", { name: "Long", sources: [porch], trigger: { type: "webhook" }, steps, edges: steps.map((s) => ({ from: "trigger", to: s.id })) });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.message).toMatch(/more than 20 items/);
      await api.data.withAccount(acc, (s) => s.db.insertInto("workflows").values(Array.from({ length: 100 }, (_, i) => ({
        id: newId("wfl"), account_id: acc, name: `w${i}`, definition: JSON.stringify({ trigger: { type: "webhook" }, steps: [{ id: "w", kind: "wait", seconds: 1 }], edges: [{ from: "trigger", to: "w" }] }),
        trigger_type: "webhook" as const, source_ids: [porch], created_by: "test", updated_by: "test",
      }))).execute());
      const full = await call(owner, "POST", "/v1/workflows", { name: "One more", sources: [porch], trigger: { type: "webhook" }, steps: [{ id: "w", kind: "wait", seconds: 1 }], edges: [{ from: "trigger", to: "w" }] });
      expect(full.statusCode).toBe(409);
      expect(full.json().error.code).toBe("limit_reached");
    });
  });

  describe("triggers", () => {
    it("starts from a signed webhook only: unsigned, wrong, stale and replayed requests start nothing", async () => {
      const wf = await create({ name: "From n8n", sources: [porch], trigger: { type: "webhook" },
        steps: [{ id: "front", kind: "condition", rules: [{ field: "input.door", op: "eq", value: "front" }] }, { id: "tell", kind: "notify", to: { type: "webhook", id: hook.id }, text: "{{input.door}} door" }],
        edges: [{ from: "trigger", to: "front" }, { from: "front", to: "tell", branch: "yes" }] });
      expect(wf.hook_secret).toMatch(/^whsec_/);
      expect(wf.hook_url).toBe(`https://api.test/v1/workflow-hooks/${wf.id}`);
      expect((await call(owner, "GET", `/v1/workflows/${wf.id}`)).json()).toMatchObject({ hook_secret_set: true });
      expect((await call(owner, "GET", `/v1/workflows/${wf.id}`)).json().hook_secret).toBeUndefined();
      const body = JSON.stringify({ door: "front" });
      expect((await hookCall(wf.id, body)).statusCode).toBe(401);
      expect((await hookCall(wf.id, body, sign("whsec_wrong", body))).statusCode).toBe(401);
      expect((await hookCall(wf.id, body, sign(wf.hook_secret, body, Math.floor(Date.now() / 1000) - 600))).statusCode).toBe(401);
      expect((await hookCall(wf.id, JSON.stringify({ door: "back" }), sign(wf.hook_secret, body))).statusCode).toBe(401);
      expect((await hookCall("wfl_nope", body, sign(wf.hook_secret, body))).statusCode).toBe(404);
      expect(await runsOf(wf.id)).toHaveLength(0);
      const signature = sign(wf.hook_secret, body);
      const ok = await hookCall(wf.id, body, signature);
      expect(ok.statusCode, ok.body).toBe(202);
      expect(ok.json().run_id).toMatch(/^wfr_/);
      const replay = await hookCall(wf.id, body, signature);
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.message).toMatch(/already used/);
      await api.workflows.runDue();
      const run = await runOf(ok.json().run_id);
      expect(run).toMatchObject({ status: "succeeded", trigger: { type: "webhook", input: { door: "front" } } });
      expect(JSON.parse(sent[0]!.req.body)).toMatchObject({ text: "front door", input: { door: "front" } });
      // A body that isn't an object, and a disabled workflow.
      const arr = "[1,2]";
      expect((await hookCall(wf.id, arr, sign(wf.hook_secret, arr))).statusCode).toBe(400);
      await call(owner, "PATCH", `/v1/workflows/${wf.id}`, { enabled: false });
      const later = JSON.stringify({ door: "side" });
      expect((await hookCall(wf.id, later, sign(wf.hook_secret, later))).statusCode).toBe(409);
      await call(owner, "PATCH", `/v1/workflows/${wf.id}`, { enabled: true });
      // A new secret: the old one stops working at once.
      const rotated = (await call(owner, "POST", `/v1/workflows/${wf.id}/hook-secret`)).json();
      expect(rotated.hook_secret).not.toBe(wf.hook_secret);
      const again = JSON.stringify({ door: "front", n: 2 });
      expect((await hookCall(wf.id, again, sign(wf.hook_secret, again))).statusCode).toBe(401);
      expect((await hookCall(wf.id, again, sign(rotated.hook_secret, again))).statusCode).toBe(202);
      // Audited, with no API key involved.
      const audit = (await call(owner, "GET", "/v1/audit?limit=100")).json().data as { action: string; actor: string; target: string }[];
      expect(audit.some((a) => a.action === "workflow.hook" && a.actor === "webhook" && a.target === wf.id)).toBe(true);
    });

    it("runs on a schedule, in the workspace's time zone, and works out the next time", async () => {
      const wf = await create({ name: "Morning", sources: [porch], trigger: { type: "schedule", at: "07:30", time_zone: "Europe/London" },
        steps: [{ id: "tell", kind: "notify", to: { type: "webhook", id: hook.id }, text: "Good morning" }], edges: [{ from: "trigger", to: "tell" }] });
      const next = new Date(wf.next_run_at);
      expect(next.getTime()).toBeGreaterThan(Date.now());
      expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }).format(next)).toBe("07:30");
      // Not due yet.
      expect(await api.workflows.fireSchedules(new Date())).toBe(0);
      expect(await api.workflows.fireSchedules(new Date(next.getTime() + 1000))).toBe(1);
      const after = (await call(owner, "GET", `/v1/workflows/${wf.id}`)).json();
      expect(Date.parse(after.next_run_at) - next.getTime()).toBeGreaterThanOrEqual(23 * 3600_000);
      const [run] = await runsOf(wf.id);
      expect((await runOf(run!.id)).trigger).toEqual({ type: "schedule", scheduled_for: next.toISOString() });
      // Turned off: no next time.
      expect((await call(owner, "PATCH", `/v1/workflows/${wf.id}`, { enabled: false })).json().next_run_at).toBeNull();
    });
  });
});
