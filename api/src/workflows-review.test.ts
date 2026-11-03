// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Workflows (ADR 0072), the second round: a run follows the workflow as it is
// now (deleted or off stops it; sources and speak steps it lost are gone), a
// person can cancel one, resumes after a wait aren't takeovers, side effects
// happen once across crashes, the database is the clock, run records go with
// the footage, the account's run cap holds under concurrency, the hook answers
// the same to every bad request, time zones and DST, an event is never lost to
// a workflow's failure, a camera doesn't trigger on its own speech, a webhook's
// input is only said aloud when allowed, and accounts are kept apart.
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent } from "./events.js";
import { type ApiBus, createApi, type SenseplaneApi } from "./index.js";
import { newId } from "./data/ids.js";
import { createPasswordUser } from "./routes/auth.js";
import { encodeWav } from "./speak.js";
import type { ObjectStorage } from "./storage.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";
import type { EgressRequest } from "./egress.js";
import { RUN_LIMITS, startRun } from "./workflow-queue.js";
import { createWorkflowEngine, derivedId, nextFireAt, pruneWorkflowRuns } from "./workflows.js";

const PW = "correct horse battery";
const log = { warn() {}, error() {}, info() {} } as never;

describe("workflows, reviewed", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let ownerUrl: string;
  let acc: string;
  let owner: string;
  let member: string;
  let other: string;
  let otherAcc: string;
  let porch: string;
  let garden: string;
  let hook: { id: string; secret: string };
  let chat: string;
  const plane = fakeMediaPlane();
  const objects = new Map<string, Buffer>();
  const storage = {
    async put(key: string, body: Uint8Array) { objects.set(key, Buffer.from(body)); },
    async copy() {}, async deleteMany(keys: string[]) { return keys.length; }, async deletePrefix() { return 0; },
    async presign() { return undefined; }, async presignPut() { return "http://bucket.test/put"; },
    async get(key: string) { const b = objects.get(key) ?? Buffer.alloc(0); return { body: Readable.from([b]), length: b.length }; },
  } as unknown as ObjectStorage;
  const bus: ApiBus = {
    async putSourceConfig() {}, async latestSnapshot() { return undefined; }, async putWatch() {}, async close() {}, async supports() { return true; },
    async request<T>(subject: string): Promise<T> {
      if (subject === "rpc.brain.check") return { yes: true, answer: "Yes.", confidence: 0.9 } as T;
      throw new Error(subject);
    },
  };
  const sent: { url: string; req: EgressRequest }[] = [];
  const sender = async (url: string, req: EgressRequest) => { sent.push({ url, req }); return { status: 200 }; };
  const tts = (async () => new Response(new Uint8Array(encodeWav({ rate: 24_000, samples: new Int16Array(24_000 * 3) })), { headers: { "content-type": "audio/wav" } })) as typeof fetch;

  const call = (key: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const create = async (body: Record<string, unknown>, key = owner) => {
    const r = await call(key, "POST", "/v1/workflows", { name: "Flow", sources: [porch, garden], ...body });
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  };
  let n = 0;
  const event = (source: string, extra: Record<string, unknown> = {}) => api.data.withAccount(acc, (s) => createEvent(s, {
    event_key: `rv-${++n}`, source_id: source, type: "detection.person", sense: "video", occurred_at: new Date(Date.now() - 60_000),
    summary: "Someone at the door", labels: ["person"], confidence: 0.9, snapshot_key: `snapshots/${acc}/${source}/e${n}.jpg`, ...extra,
  }));
  const runsOf = async (id: string) => (await call(owner, "GET", `/v1/workflows/${id}/runs`)).json().data as { id: string; status: string; error: string | null }[];
  const runOf = async (id: string) => (await call(owner, "GET", `/v1/workflow-runs/${id}`)).json();
  const due = () => api.data.withAccount(acc, async (s) => {
    await s.db.updateTable("workflow_runs").set({ due_at: sql`now() - interval '1 second'` }).where("due_at", "is not", null).execute();
    await s.db.updateTable("workflow_run_steps").set({ resume_at: sql`now() - interval '1 second'` }).where("status", "=", "waiting").execute();
  });
  const sign = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const hookCall = (id: string, body: string, signature: string) => api.public.inject({
    method: "POST", url: `/v1/workflow-hooks/${id}`, payload: body, headers: { "content-type": "application/json", "senseplane-signature": signature },
  });
  const manual = (steps: unknown[], edges: unknown[], extra: Record<string, unknown> = {}) => create({ trigger: { type: "webhook" }, steps, edges, ...extra });
  /** As the table's owner, around RLS and grants (test set-up only). */
  const asOwner = async (q: string) => {
    const c = new pg.Client({ connectionString: ownerUrl });
    await c.connect();
    try {
      return (await c.query(q)).rows;
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    const o = new URL(process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://senseplane:senseplane@localhost:55432/senseplane");
    o.pathname = new URL(t.appUrl).pathname;
    ownerUrl = o.toString();
    api = await createApi({
      database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", bus, storage, apiPublicUrl: "https://api.test",
      media: { control: plane.client, publicUrl: "https://media.test" }, workflowSender: sender,
      auth: { signupOpen: false, password: true, consoleUrls: ["https://console.test"], sessionDays: 30, inviteDays: 7, attemptsPerMinute: 1000 } as never,
      tts: { baseUrl: "http://tts.test/v1", model: "kokoro", voice: "af_heart", fetch: tts }, speakTimings: { takeMs: 1000 },
    });
    acc = (await api.data.accounts.create("Home")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    await createPasswordUser(api.data, acc, "sam@example.test", PW, "member");
    member = (await api.public.inject({ method: "POST", url: "/auth/login", payload: { email: "sam@example.test", password: PW } })).json().session;
    otherAcc = (await api.data.accounts.create("Elsewhere")).id;
    other = (await api.data.withAccount(otherAcc, (s) => s.apiKeys.create("owner"))).key;
    porch = (await call(owner, "POST", "/v1/sources", { name: "Porch phone", type: "browser" })).json().id;
    garden = (await call(owner, "POST", "/v1/sources", { name: "Garden phone", type: "browser" })).json().id;
    plane.publish(porch);
    plane.publish(garden);
    const h = (await call(owner, "POST", "/v1/webhooks", { url: "https://n8n.example.com/webhook/x", events: ["watch.triggered"] })).json();
    hook = { id: h.id, secret: h.secret };
    const agent = (await call(owner, "POST", "/v1/agents", { name: "Chat" })).json();
    chat = newId("chn");
    await api.data.withAccount(acc, (s) => s.db.insertInto("channels").values({
      id: chat, account_id: acc, kind: "telegram", chat_id: "1", chat_type: "private", name: "Family", agent_id: agent.id, agent_key: api.data.box().encrypt("sk_x"),
    }).execute());
  });
  afterAll(async () => {
    vi.useRealTimers();
    await api?.close();
    await drop?.();
  });
  beforeEach(async () => {
    sent.length = 0;
    await api.data.withAccount(acc, async (s) => {
      await s.db.deleteFrom("workflow_runs").execute();
      await s.db.deleteFrom("workflows").execute();
      await s.db.deleteFrom("speak_messages").execute();
    });
  });

  const tell = { id: "tell", kind: "notify", to: { type: "webhook", id: "" }, text: "done" };
  const tellHook = () => ({ ...tell, to: { type: "webhook", id: hook.id } });

  describe("a run follows the workflow as it is now", () => {
    it("stops, cancelled with the reason, when its workflow is turned off or deleted", async () => {
      const wf = await manual([{ id: "pause", kind: "wait", seconds: 60 }, tellHook()], [{ from: "trigger", to: "pause" }, { from: "pause", to: "tell" }]);
      const r1 = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
      await api.workflows.runDue();
      expect((await runOf(r1.id)).status).toBe("waiting");
      await call(owner, "PATCH", `/v1/workflows/${wf.id}`, { enabled: false });
      await due();
      await api.workflows.runDue();
      expect(await runOf(r1.id)).toMatchObject({ status: "cancelled", error: "the workflow was turned off, so the run was stopped" });
      expect(sent).toHaveLength(0);
      // And off, it can't be started by hand either.
      expect((await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).statusCode).toBe(409);
      await call(owner, "PATCH", `/v1/workflows/${wf.id}`, { enabled: true });
      const r2 = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
      await api.workflows.runDue();
      await call(owner, "DELETE", `/v1/workflows/${wf.id}`);
      await due();
      await api.workflows.runDue();
      const gone = await runOf(r2.id);
      expect(gone).toMatchObject({ status: "cancelled", workflow_id: null, error: "the workflow was deleted, so the run was stopped" });
      expect(gone.steps.find((s: { id: string }) => s.id === "tell").status).toBe("skipped");
      expect(sent).toHaveLength(0);
    });

    it("loses sources and speak steps the workflow lost since the run started", async () => {
      const wf = await manual(
        [{ id: "pause", kind: "wait", seconds: 60 }, { id: "say", kind: "speak", source: garden, text: "Hello there." }],
        [{ from: "trigger", to: "pause" }, { from: "pause", to: "say" }]);
      const r1 = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
      await api.workflows.runDue();
      // The speak step is taken out (the run still has it in its copy): no Speak grant any more.
      await call(owner, "PATCH", `/v1/workflows/${wf.id}`, { steps: [{ id: "pause", kind: "wait", seconds: 60 }], edges: [{ from: "trigger", to: "pause" }] });
      await due();
      await api.workflows.runDue();
      expect(await runOf(r1.id)).toMatchObject({ status: "failed", failed_step: "say", error: expect.stringContaining("no Speak permission") });
      // A source taken out of the workflow is gone for runs under way.
      await call(owner, "PATCH", `/v1/workflows/${wf.id}`, {
        steps: [{ id: "pause", kind: "wait", seconds: 60 }, { id: "say", kind: "speak", source: garden, text: "Hello there." }],
        edges: [{ from: "trigger", to: "pause" }, { from: "pause", to: "say" }],
      });
      const r2 = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
      await api.workflows.runDue();
      await call(owner, "PATCH", `/v1/workflows/${wf.id}`, { sources: [porch], steps: [{ id: "pause", kind: "wait", seconds: 60 }], edges: [{ from: "trigger", to: "pause" }] });
      await due();
      await api.workflows.runDue();
      expect(await runOf(r2.id)).toMatchObject({ status: "failed", failed_step: "say", error: expect.stringContaining("isn't one of this workflow's sources") });
      expect((await call(owner, "GET", "/v1/speak-messages")).json().data).toHaveLength(0);
    });

    it("can be cancelled by an admin: it stops, its steps left skipped, and nothing more runs", async () => {
      const wf = await manual([{ id: "pause", kind: "wait", seconds: 600 }, tellHook()], [{ from: "trigger", to: "pause" }, { from: "pause", to: "tell" }]);
      const r = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
      await api.workflows.runDue();
      expect((await call(member, "POST", `/v1/workflow-runs/${r.id}/cancel`)).statusCode).toBe(403);
      const c = await call(owner, "POST", `/v1/workflow-runs/${r.id}/cancel`);
      expect(c.statusCode, c.body).toBe(200);
      expect(c.json()).toMatchObject({ status: "cancelled", error: expect.stringMatching(/^cancelled by owner:/) });
      expect(c.json().steps.map((s: { status: string }) => s.status)).toEqual(["skipped", "skipped"]);
      await due();
      expect(await api.workflows.runDue()).toBe(0);
      expect(sent).toHaveLength(0);
      expect((await call(owner, "POST", `/v1/workflow-runs/${r.id}/cancel`)).statusCode).toBe(409);
      // A process in the middle of a step stops at its next write.
      const r2 = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
      const engine = createWorkflowEngine({ data: api.data, send: sender, log });
      const [claimed] = await engine.claim(5);
      await call(owner, "POST", `/v1/workflow-runs/${r2.id}/cancel`);
      await engine.execute(acc, claimed!.id, claimed!.token);
      expect((await runOf(r2.id)).status).toBe("cancelled");
    });
  });

  it("doesn't count resumes after a wait as takeovers: seven waits, then the notify", async () => {
    const steps = [...Array.from({ length: 7 }, (_, i) => ({ id: `w${i}`, kind: "wait", seconds: 1 })), tellHook()];
    const edges = steps.map((s, i) => ({ from: i === 0 ? "trigger" : steps[i - 1]!.id, to: s.id }));
    const wf = await manual(steps, edges);
    const r = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
    for (let i = 0; i < 9; i++) {
      await api.workflows.runDue();
      await due();
    }
    expect(await runOf(r.id)).toMatchObject({ status: "succeeded" });
    expect(sent).toHaveLength(1);
  });

  describe("side effects happen once", () => {
    it("queues a chat message and records the step in one transaction", async () => {
      // A failure while recording the step (as a crash would be) must leave no message queued to send again.
      await asOwner(`CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.step_id = 'boom' AND NEW.status = 'succeeded' THEN RAISE EXCEPTION 'crash'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER boom BEFORE INSERT OR UPDATE ON workflow_run_steps FOR EACH ROW EXECUTE FUNCTION boom()`);
      try {
        const wf = await manual([{ id: "boom", kind: "notify", to: { type: "channel", id: chat }, text: "Hello" }], [{ from: "trigger", to: "boom" }]);
        const before = (await api.data.withAccount(acc, (s) => s.db.selectFrom("channel_messages").select("id").execute())).length;
        const r = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
        await api.workflows.runDue();
        expect((await api.data.withAccount(acc, (s) => s.db.selectFrom("channel_messages").select("id").execute())).length).toBe(before);
        expect((await runOf(r.id)).steps[0]).toMatchObject({ id: "boom", status: "waiting", error: "crash" });
      } finally {
        await asOwner("DROP TRIGGER boom ON workflow_run_steps; DROP FUNCTION boom()");
      }
    });

    it("makes the same clip and story when a step runs again after a crash", async () => {
      const at = Date.now() - 120_000;
      await api.data.withAccount(acc, (s) => s.db.insertInto("segments").values([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
        account_id: acc, source_id: porch, key: `seg/${porch}/${at}-${i}.m4s`, init_key: `seg/${porch}/init.mp4`, start_at: new Date(at - 20_000 + i * 6000), duration_ms: 6000, bytes: 1000, codec: "avc1",
      }))).execute());
      const wf = await create({ trigger: { type: "event", sources: [porch] }, steps: [{ id: "keep", kind: "clip" }, { id: "tale", kind: "story", mode: "fast" }],
        edges: [{ from: "trigger", to: "keep" }, { from: "keep", to: "tale" }] });
      await event(porch, { occurred_at: new Date(at) });
      await api.workflows.runDue();
      const [run] = await runsOf(wf.id);
      const first = await runOf(run!.id);
      expect(first.status, first.error).toBe("succeeded");
      expect(first.steps[0].output.clip_id).toBe(derivedId("clp", run!.id, "keep"));
      expect(first.steps[1].output.story_id).toBe(derivedId("sty", run!.id, "tale"));
      // As if the process died after making them, before recording the steps: both run again.
      await api.data.withAccount(acc, async (s) => {
        await s.db.updateTable("workflow_run_steps").set({ status: "running", output: null }).where("run_id", "=", run!.id).execute();
        await s.db.updateTable("workflow_runs").set({ status: "running", due_at: sql`now()`, finished_at: null, claimed_until: sql`now() - interval '1 second'`, claim_token: "dead" }).where("id", "=", run!.id).execute();
      });
      await api.workflows.runDue();
      const again = await runOf(run!.id);
      expect(again.status).toBe("succeeded");
      expect(again.steps.map((s: { output: Record<string, unknown> }) => Object.values(s.output)[0])).toEqual([first.steps[0].output.clip_id, first.steps[1].output.story_id]);
      const counts = await api.data.withAccount(acc, async (s) => ({
        clips: (await s.db.selectFrom("clips").select("id").where("id", "=", first.steps[0].output.clip_id).execute()).length,
        stories: (await s.db.selectFrom("stories").select("id").where("created_by", "=", `workflow:${wf.id}`).execute()).length,
      }));
      expect(counts).toEqual({ clips: 1, stories: 1 });
    });
  });

  describe("the database is the clock", () => {
    it("parks a wait, retries and schedules by the database's clock, whatever this process's clock says", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 3600_000 });
      try {
        const wf = await manual([{ id: "pause", kind: "wait", seconds: 600 }], [{ from: "trigger", to: "pause" }]);
        const r = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
        expect(await api.workflows.runDue()).toBe(1);
        const [row] = await asOwner(`SELECT extract(epoch FROM due_at - now()) AS due_in, extract(epoch FROM s.resume_at - now()) AS resume_in
          FROM workflow_runs r JOIN workflow_run_steps s ON s.run_id = r.id WHERE r.id = '${r.id}'`);
        expect(Number(row.due_in)).toBeGreaterThan(590);
        expect(Number(row.due_in)).toBeLessThan(610);
        expect(Number(row.resume_in)).toBeLessThan(610);
        const sched = await create({ trigger: { type: "schedule", every_min: 5 }, steps: [tellHook()], edges: [{ from: "trigger", to: "tell" }] });
        const [s] = await asOwner(`SELECT extract(epoch FROM next_fire_at - now()) AS in_s FROM workflows WHERE id = '${sched.id}'`);
        expect(Number(s.in_s)).toBeGreaterThan(290);
        expect(Number(s.in_s)).toBeLessThan(310);
      } finally {
        vi.useRealTimers();
      }
    });

    it("works schedules out again when the workspace's time zone changes, and keeps to wall time across DST", async () => {
      // Spring forward (London, 28 Mar 2027 01:00 → 02:00): 01:30 doesn't exist, so it is the gap later (02:30 BST, 01:30 UTC).
      expect(nextFireAt({ type: "schedule", at: "01:30" }, "Europe/London", new Date("2027-03-27T12:00:00Z"), false).toISOString()).toBe("2027-03-28T01:30:00.000Z");
      expect(nextFireAt({ type: "schedule", at: "07:00" }, "Europe/London", new Date("2027-03-27T12:00:00Z"), false).toISOString()).toBe("2027-03-28T06:00:00.000Z");
      // Fall back (25 Oct 2026 02:00 → 01:00): 01:30 happens twice; it is the earlier one (BST, 00:30 UTC).
      expect(nextFireAt({ type: "schedule", at: "01:30" }, "Europe/London", new Date("2026-10-24T12:00:00Z"), false).toISOString()).toBe("2026-10-25T00:30:00.000Z");
      expect(nextFireAt({ type: "schedule", at: "07:00" }, "Europe/London", new Date("2026-10-24T12:00:00Z"), false).toISOString()).toBe("2026-10-25T07:00:00.000Z");
      // A schedule that follows the workspace's zone moves with it; one with its own zone doesn't.
      await call(owner, "PATCH", "/v1/account", { time_zone: "UTC" });
      const follows = await create({ trigger: { type: "schedule", at: "08:00" }, steps: [tellHook()], edges: [{ from: "trigger", to: "tell" }] });
      const own = await create({ trigger: { type: "schedule", at: "08:00", time_zone: "UTC" }, steps: [tellHook()], edges: [{ from: "trigger", to: "tell" }] });
      expect(new Date(follows.next_run_at).getUTCHours()).toBe(8);
      expect((await call(owner, "PATCH", "/v1/account", { time_zone: "Asia/Tokyo" })).statusCode).toBe(200);
      const moved = (await call(owner, "GET", `/v1/workflows/${follows.id}`)).json();
      expect(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(new Date(moved.next_run_at))).toBe("08:00");
      expect((await call(owner, "GET", `/v1/workflows/${own.id}`)).json().next_run_at).toBe(own.next_run_at);
      await call(owner, "PATCH", "/v1/account", { time_zone: "UTC" });
    });
  });

  describe("records go with the footage", () => {
    it("prunes runs by their sources' shortest retention, and forgets outputs when the event or the source goes", async () => {
      const wf = await create({ trigger: { type: "event", sources: [porch] }, steps: [{ id: "look", kind: "ask", question: "A parcel?" }], edges: [{ from: "trigger", to: "look" }] });
      const ev = await event(porch);
      await api.workflows.runDue();
      const [run] = await runsOf(wf.id);
      expect((await runOf(run!.id)).steps[0].output).toMatchObject({ answer: "Yes." });
      await api.data.withAccount(acc, (s) => s.db.deleteFrom("events").where("id", "=", ev!.id).execute());
      expect((await runOf(run!.id)).steps[0].output).toBeNull();
      // A hook's input goes when one of the run's sources is deleted.
      const hookWf = await manual([{ id: "c", kind: "condition", rules: [{ field: "input.door", op: "exists" }] }], [{ from: "trigger", to: "c" }], { sources: [garden] });
      const body = JSON.stringify({ door: "front" });
      const ok = await hookCall(hookWf.id, body, sign(hookWf.hook_secret, body));
      expect(ok.statusCode).toBe(202);
      const spare = (await call(owner, "POST", "/v1/sources", { name: "Spare", type: "browser" })).json().id;
      await api.data.withAccount(acc, (s) => s.db.updateTable("workflow_runs").set({ source_ids: [garden, spare] }).where("id", "=", ok.json().run_id).execute());
      await api.data.withAccount(acc, (s) => s.db.deleteFrom("sources").where("id", "=", spare).execute());
      expect((await runOf(ok.json().run_id)).trigger).toEqual({ type: "webhook" });
      // Retention: a source keeping 1 day takes its runs after a day, well before 30.
      await call(owner, "PATCH", `/v1/sources/${porch}`, { retention_days: 1 });
      await api.data.withAccount(acc, async (s) => {
        await s.db.updateTable("workflow_runs").set({ created_at: sql`now() - interval '2 days'` }).execute();
      });
      const kept = await api.data.withAccount(acc, (s) => s.db.selectFrom("workflow_runs").select(["id", "source_ids"]).execute());
      await pruneWorkflowRuns(api.data);
      const left = await api.data.withAccount(acc, (s) => s.db.selectFrom("workflow_runs").select("id").execute());
      expect(left.map((r) => r.id)).toEqual(kept.filter((r) => !r.source_ids.includes(porch)).map((r) => r.id));
      await call(owner, "PATCH", `/v1/sources/${porch}`, { retention_days: null });
    });
  });

  describe("concurrency", () => {
    it("holds the account's hourly cap when runs start at the same time", async () => {
      const saved = RUN_LIMITS.accountPerHour;
      RUN_LIMITS.accountPerHour = 3;
      try {
        const a = await manual([{ id: "w", kind: "wait", seconds: 1 }], [{ from: "trigger", to: "w" }]);
        const b = await manual([{ id: "w", kind: "wait", seconds: 1 }], [{ from: "trigger", to: "w" }]);
        const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => api.data.withAccount(acc, (s) => startRun(s, i % 2 ? a.id : b.id, { type: "manual", by: "test" }))));
        expect(outs.filter((o) => "run" in o)).toHaveLength(3);
        expect(outs.filter((o) => "dropped" in o && o.dropped === "account")).toHaveLength(7);
      } finally {
        RUN_LIMITS.accountPerHour = saved;
      }
    });

    it("starts at most 10 runs from 15 events at once, and loses none of the events", async () => {
      const wf = await create({ trigger: { type: "event", sources: [porch] }, steps: [{ id: "w", kind: "wait", seconds: 1 }], edges: [{ from: "trigger", to: "w" }] });
      const evs = await Promise.all(Array.from({ length: 15 }, () => event(porch)));
      expect(evs.every(Boolean)).toBe(true);
      expect(await runsOf(wf.id)).toHaveLength(10);
      expect((await call(owner, "GET", `/v1/workflows/${wf.id}`)).json().runs_dropped).toBe(5);
    });

    it("keeps the event when queueing workflows fails", async () => {
      await api.data.withAccount(acc, (s) => s.db.insertInto("workflows").values({
        id: newId("wfl"), account_id: acc, name: "Broken", definition: JSON.stringify("not a definition"), trigger_type: "event", source_ids: [porch], created_by: "test", updated_by: "test",
      }).execute());
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const ev = await event(porch);
        expect(ev?.id).toMatch(/^evt_/);
        expect(await api.data.withAccount(acc, (s) => s.db.selectFrom("events").select("id").where("id", "=", ev!.id).executeTakeFirst())).toBeDefined();
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("speech", () => {
    it("ignores events on a camera while the workflow speaks through it, and warns at save time", async () => {
      const wf = await create({ trigger: { type: "event", event_types: ["sound.*", "detection.*"], sources: [porch] },
        steps: [{ id: "say", kind: "speak", source: porch, text: "The shop is closed." }], edges: [{ from: "trigger", to: "say" }] });
      expect(wf.warnings).toEqual([expect.stringContaining("Porch phone speaks and its sound events start this workflow")]);
      await event(porch);
      await api.workflows.runDue();
      expect((await call(owner, "GET", "/v1/speak-messages")).json().data).toHaveLength(1);
      // The camera hears it: a sound event during the message (and just after) starts nothing.
      await event(porch, { type: "sound.speech", sense: "audio" });
      expect(await runsOf(wf.id)).toHaveLength(1);
      // Long after, it does again.
      await api.data.withAccount(acc, (s) => s.db.updateTable("speak_messages").set({ ends_at: sql`now() - interval '1 minute'`, finished_at: sql`now() - interval '1 minute'` }).execute());
      await event(porch, { type: "sound.speech", sense: "audio" });
      expect(await runsOf(wf.id)).toHaveLength(2);
      // No warning when its sound events can't start it.
      const quiet = await create({ trigger: { type: "event", event_types: ["detection.person"], sources: [porch] },
        steps: [{ id: "say", kind: "speak", source: porch, text: "Hi." }], edges: [{ from: "trigger", to: "say" }] });
      expect(quiet.warnings).toBeUndefined();
    });

    it("says a webhook's input aloud only when the step allows it", async () => {
      const steps = (allow?: boolean) => [{ id: "say", kind: "speak", source: porch, text: "Message: {{input.text}}", ...(allow === undefined ? {} : { allow_input: allow }) }];
      const refused = await call(owner, "POST", "/v1/workflows", { name: "Say", sources: [porch], trigger: { type: "webhook" }, steps: steps(), edges: [{ from: "trigger", to: "say" }] });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.message).toMatch(/set allow_input/);
      const wf = await manual(steps(true), [{ from: "trigger", to: "say" }], { sources: [porch] });
      const body = JSON.stringify({ text: "the door is open" });
      await hookCall(wf.id, body, sign(wf.hook_secret, body));
      await api.workflows.runDue();
      expect((await call(owner, "GET", "/v1/speak-messages")).json().data[0].text).toBe("Message: the door is open");
      // A definition written around the API without it: the input reads as empty.
      await api.data.withAccount(acc, async (s) => {
        await s.db.deleteFrom("speak_messages").execute();
        await s.db.updateTable("workflows").set({ definition: JSON.stringify({ trigger: { type: "webhook" }, steps: steps(false), edges: [{ from: "trigger", to: "say" }] }) }).where("id", "=", wf.id).execute();
      });
      const body2 = JSON.stringify({ text: "something else" });
      const r = await hookCall(wf.id, body2, sign(wf.hook_secret, body2));
      await api.workflows.runDue();
      expect(await runOf(r.json().run_id)).toMatchObject({ status: "failed", error: expect.stringContaining("allow_input") });
    });
  });

  it("keeps accounts apart on every workflow route and on the hook", async () => {
    const wf = await manual([{ id: "w", kind: "wait", seconds: 1 }], [{ from: "trigger", to: "w" }]);
    const r = (await call(owner, "POST", `/v1/workflows/${wf.id}/run`, {})).json();
    for (const [m, u, b] of [
      ["GET", `/v1/workflows/${wf.id}`], ["PATCH", `/v1/workflows/${wf.id}`, { enabled: false }], ["DELETE", `/v1/workflows/${wf.id}`],
      ["POST", `/v1/workflows/${wf.id}/run`, {}], ["GET", `/v1/workflows/${wf.id}/runs`], ["POST", `/v1/workflows/${wf.id}/hook-secret`],
      ["GET", `/v1/workflow-runs/${r.id}`], ["POST", `/v1/workflow-runs/${r.id}/cancel`],
    ] as const) {
      const res = await call(other, m, u, b);
      expect(res.statusCode, `${m} ${u}`).toBe(404);
    }
    expect((await call(other, "GET", "/v1/workflows")).json().data).toEqual([]);
    expect((await call(owner, "GET", `/v1/workflows/${wf.id}`)).json().enabled).toBe(true);
    // The other account's own hook secret signs nothing for this workflow.
    const theirs = (await call(other, "POST", "/v1/sources", { name: "Theirs", type: "browser" })).json().id;
    const mine = (await call(other, "POST", "/v1/workflows", { name: "Theirs", sources: [theirs], trigger: { type: "webhook" }, steps: [{ id: "w", kind: "wait", seconds: 1 }], edges: [{ from: "trigger", to: "w" }] })).json();
    const body = "{}";
    expect((await hookCall(wf.id, body, sign(mine.hook_secret, body))).statusCode).toBe(401);
    expect((await hookCall(mine.id, body, sign(mine.hook_secret, body))).statusCode).toBe(202);
    expect(await runsOf(wf.id)).toHaveLength(1);
  });
});
