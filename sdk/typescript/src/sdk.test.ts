// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { Senseplane, SenseplaneDemo, SenseplaneError, WebhookVerificationError, signWebhook, verifyWebhook } from "./index.js";

const event = { id: "evt_1", type: "detection.person", source: { id: "src_1", sense: "video" } };

describe("webhooks", () => {
  it("round-trips a signed payload", () => {
    const body = JSON.stringify(event);
    const sig = signWebhook(body, "whsec_test");
    expect(verifyWebhook(body, sig, "whsec_test").id).toBe("evt_1");
  });

  it("rejects a tampered body, wrong secret and stale timestamp", () => {
    const body = JSON.stringify(event);
    const sig = signWebhook(body, "whsec_test", 1_000);
    expect(() => verifyWebhook(body + " ", sig, "whsec_test", { now: 1_000 })).toThrow(WebhookVerificationError);
    expect(() => verifyWebhook(body, sig, "other", { now: 1_000 })).toThrow(WebhookVerificationError);
    expect(() => verifyWebhook(body, sig, "whsec_test", { now: 2_000 })).toThrow(/tolerance/);
  });
});

describe("client", () => {
  it("paginates with cursors and sends the API key", async () => {
    const seen: string[] = [];
    const fakeFetch = async (req: Request) => {
      seen.push(req.headers.get("authorization") ?? "");
      const cursor = new URL(req.url).searchParams.get("cursor");
      const body = cursor
        ? { data: [{ id: "src_2" }], next_cursor: null }
        : { data: [{ id: "src_1" }], next_cursor: "c1" };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    const sp = new Senseplane({ apiKey: "sk_test", baseUrl: "http://x/v1", fetch: fakeFetch as typeof fetch });
    const ids: string[] = [];
    for await (const s of sp.sources.list()) ids.push(s.id);
    expect(ids).toEqual(["src_1", "src_2"]);
    expect(seen.every((h) => h === "Bearer sk_test")).toBe(true);
  });

  it("calls the inbox and backtest endpoints", async () => {
    const calls: string[] = [];
    const fakeFetch = async (req: Request) => {
      const u = new URL(req.url);
      calls.push(`${req.method} ${u.pathname}${u.search} ${req.method === "POST" ? await req.text() : ""}`.trim());
      const body = u.pathname.endsWith("/inbox") ? { agent_id: "agt_1", data: [], next_cursor: null } : u.pathname.endsWith("/seen") ? { marked: 2 } : { matches: [], checks_used: 0, candidates: 0, unchecked: 0, compiled: {} };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    const sp = new Senseplane({ apiKey: "k", baseUrl: "http://x/v1", fetch: fakeFetch as typeof fetch });
    expect((await sp.inbox.list({ unseen: true })).agent_id).toBe("agt_1");
    expect((await sp.inbox.markSeen({ ids: ["inb_1", "inb_2"] })).marked).toBe(2);
    expect((await sp.watches.test({ instruction: "Someone at the door", sources: ["Front door"], from: "2026-10-16T09:00:00Z", to: "2026-10-16T10:00:00Z" })).checks_used).toBe(0);
    expect(calls).toEqual([
      "GET /v1/inbox?unseen=true",
      'POST /v1/inbox/seen {"ids":["inb_1","inb_2"]}',
      'POST /v1/watches/test {"instruction":"Someone at the door","sources":["Front door"],"from":"2026-10-16T09:00:00Z","to":"2026-10-16T10:00:00Z"}',
    ]);
  });

  it("pushes readings with an integration token after learning its source", async () => {
    const seen: string[] = [];
    const fakeFetch = async (req: Request) => {
      seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("authorization")}`);
      const body = req.method === "GET" ? { source: { id: "src_s" } } : { accepted: 1, events: [] };
      return new Response(JSON.stringify(body), { status: req.method === "GET" ? 200 : 202, headers: { "content-type": "application/json" } });
    };
    const sp = new Senseplane({ apiKey: "sit_test", baseUrl: "http://x/v1", fetch: fakeFetch as typeof fetch });
    const { source } = await sp.integration.get();
    expect((await sp.sources.pushReadings(source.id, { readings: [{ sense: "temperature", value: 21, unit: "celsius", at: "2026-10-16T10:00:00Z" }] })).accepted).toBe(1);
    expect(seen).toEqual(["GET /v1/integration Bearer sit_test", "POST /v1/sources/src_s/readings Bearer sit_test"]);
  });

  it("shows a sensor's readings webhook and turns signing on and off", async () => {
    const seen: string[] = [];
    const fakeFetch = async (req: Request) => {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      const body = { url: "http://x/v1/integration/readings", token_prefix: "sit_abcd", signed: req.method === "POST", ...(req.method === "POST" ? { secret: "whsec_s" } : {}) };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    const sp = new Senseplane({ apiKey: "sk_test", baseUrl: "http://x/v1", fetch: fakeFetch as typeof fetch });
    expect((await sp.sources.webhook("src_s")).signed).toBe(false);
    expect((await sp.sources.createWebhookSecret("src_s")).secret).toBe("whsec_s");
    await sp.sources.deleteWebhookSecret("src_s");
    expect(seen).toEqual(["GET /v1/sources/src_s/webhook", "POST /v1/sources/src_s/webhook/secret", "DELETE /v1/sources/src_s/webhook/secret"]);
  });

  it("speaks through a camera and lists what was said", async () => {
    const calls: string[] = [];
    const fakeFetch = async (req: Request) => {
      const u = new URL(req.url);
      calls.push(`${req.method} ${u.pathname}${u.search} ${req.method === "POST" ? await req.text() : ""}`.trim());
      const msg = { id: "spk_1", source_id: "src_1", kind: "agent", text: "Hello", status: "playing", created_at: "2026-11-03T10:00:00Z" };
      return new Response(JSON.stringify(u.pathname.endsWith("/speak-messages") ? { data: [msg] } : msg), { headers: { "content-type": "application/json" } });
    };
    const sp = new Senseplane({ apiKey: "k", baseUrl: "http://x/v1", fetch: fakeFetch as typeof fetch });
    expect((await sp.sources.speak("src_1", "Hello")).status).toBe("playing");
    expect((await sp.speakMessages.list({ source: "src_1" }))[0]!.id).toBe("spk_1");
    expect((await sp.speakMessages.get("spk_1")).text).toBe("Hello");
    expect(calls).toEqual(['POST /v1/sources/src_1/speak {"text":"Hello"}', "GET /v1/speak-messages?source=src_1", "GET /v1/speak-messages/spk_1"]);
  });

  it("throws a typed error", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ error: { code: "forbidden_sense", message: "no audio grant", request_id: "r1" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const sp = new Senseplane({ apiKey: "k", baseUrl: "http://x/v1", fetch: fakeFetch as typeof fetch });
    await expect(sp.sources.get("src_1")).rejects.toMatchObject({ status: 403, code: "forbidden_sense" });
    await expect(sp.sources.get("src_1")).rejects.toBeInstanceOf(SenseplaneError);
  });

  it("calls the team endpoints", async () => {
    const calls: string[] = [];
    const fakeFetch = async (req: Request) => {
      calls.push(`${req.method} ${new URL(req.url).pathname} ${req.method === "GET" || req.method === "DELETE" ? "" : await req.text()}`.trim());
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      const body = new URL(req.url).pathname === "/v1/members" ? { data: [{ id: "usr_1", role: "owner" }], next_cursor: null } : {};
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    const sp = new Senseplane({ apiKey: "k", baseUrl: "http://x/v1", fetch: fakeFetch as typeof fetch });
    await sp.me.switchWorkspace("acc_2");
    await sp.invites.create({ email: "a@example.test", role: "viewer" });
    await sp.members.update("usr_1", "admin");
    await sp.members.remove("usr_1");
    const ids: string[] = [];
    for await (const m of sp.members.list()) ids.push(m.id);
    expect(ids).toEqual(["usr_1"]);
    expect(calls).toEqual([
      'POST /v1/me/switch {"account_id":"acc_2"}',
      'POST /v1/invites {"email":"a@example.test","role":"viewer"}',
      'PATCH /v1/members/usr_1 {"role":"admin"}',
      "DELETE /v1/members/usr_1",
      "GET /v1/members",
    ]);
  });
});

describe("workflows", () => {
  it("calls the workflow endpoints", async () => {
    const calls: string[] = [];
    const fakeFetch = async (req: Request) => {
      const u = new URL(req.url);
      calls.push(`${req.method} ${u.pathname}${u.search} ${["POST", "PATCH"].includes(req.method) ? await req.text() : ""}`.trim());
      const body = u.pathname.endsWith("/runs") || u.pathname.endsWith("/workflows") && req.method === "GET" ? { data: [{ id: "x" }], next_cursor: null } : { id: "wfl_1" };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    const sp = new Senseplane({ apiKey: "k", baseUrl: "http://x/v1", fetch: fakeFetch as typeof fetch });
    const def = { trigger: { type: "webhook" as const }, steps: [{ id: "pause", kind: "wait" as const, seconds: 5 }], edges: [{ from: "trigger", to: "pause" }] };
    await sp.workflows.create({ name: "Door", sources: ["src_1"], ...def });
    await sp.workflows.update("wfl_1", { enabled: false });
    expect(await sp.workflows.list()).toEqual([{ id: "x" }]);
    await sp.workflows.run("wfl_1", { door: "front" });
    expect(await sp.workflows.runs("wfl_1", { status: "failed", limit: 5 })).toEqual([{ id: "x" }]);
    await sp.workflows.getRun("wfr_1");
    await sp.workflows.cancelRun("wfr_1");
    await sp.workflows.rotateHookSecret("wfl_1");
    await sp.workflows.delete("wfl_1");
    expect(calls).toEqual([
      `POST /v1/workflows ${JSON.stringify({ name: "Door", sources: ["src_1"], ...def })}`,
      'PATCH /v1/workflows/wfl_1 {"enabled":false}',
      "GET /v1/workflows",
      'POST /v1/workflows/wfl_1/run {"input":{"door":"front"}}',
      "GET /v1/workflows/wfl_1/runs?status=failed&limit=5",
      "GET /v1/workflow-runs/wfr_1",
      "POST /v1/workflow-runs/wfr_1/cancel",
      "POST /v1/workflows/wfl_1/hook-secret",
      "DELETE /v1/workflows/wfl_1",
    ]);
  });

  it("signs a webhook trigger over the exact body, without the API key", async () => {
    let seen: Request | undefined;
    const fakeFetch = async (req: Request) => {
      seen = req.clone();
      return new Response(JSON.stringify({ run_id: "wfr_1", status: "queued" }), { status: 202, headers: { "content-type": "application/json" } });
    };
    const sp = new Senseplane({ apiKey: "sk_secret", baseUrl: "http://x/v1", fetch: fakeFetch as typeof fetch });
    expect(await sp.workflows.trigger("wfl_1", "whsec_hook", { door: "front", n: 2 })).toEqual({ run_id: "wfr_1", status: "queued" });
    expect(seen!.url).toBe("http://x/v1/workflow-hooks/wfl_1");
    expect(seen!.headers.get("authorization")).toBeNull();
    const body = await seen!.text();
    expect(body).toBe('{"door":"front","n":2}');
    // What the API checks: the same signature as Senseplane's own webhooks, over that body.
    expect(verifyWebhook(body, seen!.headers.get("senseplane-signature") ?? undefined, "whsec_hook")).toEqual({ door: "front", n: 2 });
    expect(() => verifyWebhook(body, seen!.headers.get("senseplane-signature") ?? undefined, "whsec_other")).toThrow(WebhookVerificationError);
  });
});

describe("demo stream", () => {
  it("parses server-sent events split across chunks", async () => {
    const chunks = ['event: status\ndata: {"camera":"online"}\n\nevent: ev', 'ent\ndata: {"id":"evt_1","summary":"A person"}\n\n: keep-alive\n\nevent: ended\ndata: {"reason":"expired"}\n\n'];
    const body = new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
    const demo = new SenseplaneDemo("http://x/v1", (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch);
    const seen: string[] = [];
    await demo.stream({ id: "dem_1", token: "t" }, { status: (s) => seen.push(s.camera), event: (e) => seen.push(e.summary), ended: (e) => seen.push(e.reason) });
    expect(seen).toEqual(["online", "A person", "expired"]);
  });
});

describe("conversations", () => {
  const sse = (chunks: string[]) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });

  it("streams an answer as typed events and sends the key in a header", async () => {
    const seen: Request[] = [];
    const fakeFetch = async (req: Request) => {
      seen.push(req);
      return new Response(sse([
        'event: status\ndata: {"text":"Searching Front door…"}\n\nevent: mo',
        'ment\ndata: {"source_id":"src_1","source_name":"Front door","at":"2026-10-16T10:02:00Z","label":"A person","snapshot_url":null}\n\n: keep-alive\n\n',
        'event: delta\ndata: {"text":"At 10:02 [1]."}\n\nevent: done\ndata: {"message":{"id":"msg_1","role":"assistant","content":"At 10:02 [1].","moments":[],"created_at":"2026-10-16T10:03:00Z"}}\n\n',
      ]), { headers: { "content-type": "text/event-stream" } });
    };
    const sp = new Senseplane({ apiKey: "sk_test", baseUrl: "http://x/v1", fetch: fakeFetch as typeof fetch });
    const names: string[] = [];
    let text = "";
    for await (const e of sp.conversations.stream("cnv_1", { content: "When did someone come?" })) {
      names.push(e.event);
      if (e.event === "delta") text += e.data.text;
      if (e.event === "done") expect(e.data.message.id).toBe("msg_1");
    }
    expect(names).toEqual(["status", "moment", "delta", "done"]);
    expect(text).toBe("At 10:02 [1].");
    expect(seen[0]!.url).toBe("http://x/v1/conversations/cnv_1/messages");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer sk_test");
    expect(seen[0]!.headers.get("accept")).toBe("text/event-stream");
    expect(await seen[0]!.json()).toEqual({ content: "When did someone come?" });
  });

  it("throws a typed error before the stream starts, and sends as JSON", async () => {
    const fakeFetch = async (req: Request) => req.headers.get("accept") === "text/event-stream"
      ? new Response(JSON.stringify({ error: { code: "not_found", message: "conversation not found", request_id: "r2" } }), { status: 404, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ id: "msg_2", role: "assistant", content: "Nothing found.", moments: [], created_at: "2026-10-16T10:03:00Z" }), { headers: { "content-type": "application/json" } });
    const sp = new Senseplane({ apiKey: "k", baseUrl: "http://x/v1", fetch: fakeFetch as typeof fetch });
    const drain = async () => { for await (const e of sp.conversations.stream("cnv_x", { content: "Hi" })) void e; };
    await expect(drain()).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect((await sp.conversations.send("cnv_1", { content: "Hi" })).content).toBe("Nothing found.");
  });
});
