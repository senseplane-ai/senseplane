// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LABELS, Senseplane } from "senseplane";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpServer } from "./handlers.js";
import { createMcpService } from "./service.js";
import { tools } from "./tools.js";

const KEY = "sk_test_key";
const SOURCES = [
  { id: "src_cam", name: "Front door", location: "Door", type: "browser", senses: ["video"], status: "online", record_audio: false, retention_days: null, zones: [], privacy_masks: [], sensor_thresholds: null, created_at: "2026-10-16T00:00:00Z" },
  { id: "src_th", name: "Kitchen sensor", location: "Kitchen", type: "sensor", senses: ["temperature", "humidity"], status: "online", record_audio: false, retention_days: null, zones: [], privacy_masks: [], sensor_thresholds: null, created_at: "2026-10-16T00:00:00Z" },
];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

/** Connect codes the fake API handed out on consent: code → the binding and app it was approved for. */
const approvals = new Map<string, { binding: string; client_name: string; redirect_host: string }>();
const sha = (s: string) => createHash("sha256").update(s).digest("base64url");

/** A tiny fake of the Senseplane API: just what the tools call, and the connect-code redeem (ADR 0048). */
const fakeApi: typeof fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url);
  if (url.pathname === "/auth/connect/redeem") {
    const b = await req.json();
    const a = approvals.get(b.code);
    approvals.delete(b.code);
    if (!a) return Response.json({ error: { code: "validation_failed", message: "x", request_id: "r", details: { reason: "code_invalid" } } }, { status: 400 });
    if (a.binding !== sha(b.nonce) || a.client_name !== b.client_name || a.redirect_host !== b.redirect_host) {
      return Response.json({ error: { code: "validation_failed", message: "x", request_id: "r", details: { reason: "mismatch" } } }, { status: 400 });
    }
    return Response.json({ api_key: KEY, agent_id: "agt_1" });
  }
  if (req.headers.get("authorization") !== `Bearer ${KEY}` && !url.pathname.endsWith(".jpg")) {
    return Response.json({ error: { code: "unauthorized", message: "bad key", request_id: "r" } }, { status: 401 });
  }
  const p = url.pathname.replace(/^\/v1/, "");
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  if (p.endsWith(".jpg")) return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
  if (p === "/sources") return json({ data: SOURCES, next_cursor: null });
  if (p === "/sources/src_cam/now") return json({ source_id: "src_cam", captured_at: "2026-10-16T01:00:00Z", snapshot_url: "http://api/media/t/snapshot.jpg" });
  if (p === "/sources/src_cam/ask") return json({ answer: "A parcel is on the step.", confidence: 0.9, snapshot_url: "http://api/media/t2/snapshot.jpg" });
  if (p === "/sources/src_th/now") return json({ source_id: "src_th", captured_at: "2026-10-16T01:00:00Z", readings: [{ sense: "temperature", value: 22.4, unit: "celsius", measured_at: "2026-10-16T01:00:00Z" }] });
  if (p === "/sources/src_th/history") return json({ data: [{ sense: "temperature", value: 21.0, unit: "celsius", measured_at: "2026-10-16T00:05:00Z" }] });
  if (p === "/watches" && req.method === "POST") {
    const b = await req.json();
    return json({ id: "wat_1", instruction: b.instruction, sources: b.sources, mode: "alert", compiled: { trigger: { type: "objects", label: "person", on: "enter" } }, estimate: {}, status: "active", warnings: [], expires_at: b.duration_minutes ? "2026-10-16T02:00:00Z" : null, created_at: "2026-10-16T01:00:00Z" }, 201);
  }
  if (p === "/watches/wat_1" && req.method === "DELETE") return new Response(null, { status: 204 });
  if (p === "/memory/search") return json({ data: [{ score: 0.81, event: { id: "evt_1", type: "watch.triggered", source: { id: "src_cam", sense: "video" }, occurred_at: "2026-10-16T00:30:00Z", summary: "A courier left a parcel.", labels: [], confidence: 0.9, media: { clip_url: "http://api/c" } } }] });
  if (p === "/events") return json({ data: [], next_cursor: null });
  if (p === "/sources/src_cam/playback") return json({ url: "http://api/playback/t/index.m3u8", expires_at: "2026-10-16T01:15:00Z", gaps: [] });
  if (p === "/clips" && req.method === "POST") return json({ id: "clp_1" }, 201);
  if (p === "/activity/query" && req.method === "POST") {
    const b = await req.json();
    return json({ measure: b.measure, value: 2, unit: "count", window: { from: "2026-10-15T23:00:00Z", to: "2026-10-16T01:00:00Z", time_zone: "Europe/London" }, matched: 2,
      coverage: { recorded: 1, complete: true, gaps: [] }, evidence: [], notes: [], echo: b });
  }
  if (p === "/activity/check" && req.method === "POST") {
    const b = await req.json();
    return json({ matches: [{ source_id: "src_cam", source_name: "Front door", at: "2026-10-16T00:20:00Z", summary: "A person takes a pill.", verified: true }],
      checks_used: 3, candidates: 4, unchecked: 1, compiled: {}, stored: b.watch_id ? 1 : 0 });
  }
  return json({ error: { code: "not_found", message: p, request_id: "r" } }, 404);
};

const ARGS: Record<string, Record<string, unknown>> = {
  list_senses: {},
  look: { source: "front door" },
  listen: { source: "src_cam", seconds: 1 },
  read_environment: { room: "kitchen" },
  watch_for: { condition: "Tell me when someone comes to the door", sources: ["Front door"], duration_minutes: 60 },
  what_happened: { question: "When did the courier come?" },
  measure: { measure: "count", what: { watch_id: "wat_1" }, period: "today" },
  check_history: { instruction: "a person taking pills", sources: ["Front door"] },
  replay: { source: "src_cam", from: "2026-10-16T00:29:00Z", to: "2026-10-16T00:31:00Z", save: true },
  stop_watching: { watch_id: "wat_1" },
};

describe("mcp tools", () => {
  let client: Client;
  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(new Senseplane({ apiKey: KEY, baseUrl: "http://api/v1", fetch: fakeApi }), fakeApi).connect(a);
    client = new Client({ name: "test", version: "1" });
    await client.connect(b);
  });

  it("lists exactly the 10 tools from the spec", async () => {
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).toEqual(["list_senses", "look", "listen", "read_environment", "watch_for", "what_happened", "measure", "check_history", "replay", "stop_watching"]);
    expect(listed).toEqual(tools.map((t) => t.name));
  });

  it("tells agents that everyday objects can be watched cheaply", async () => {
    const watchFor = (await client.listTools()).tools.find((t) => t.name === "watch_for")!;
    expect(watchFor.description).toMatch(/64 everyday objects/);
    expect(watchFor.description).toMatch(/takes the laptop/);
    const objects = LABELS.filter((l) => !("group" in l));
    expect(objects.length).toBe(64);
  });

  it("calls every tool", async () => {
    const out: Record<string, { isError?: boolean; content: { type: string; text?: string; data?: string }[] }> = {};
    for (const t of tools) out[t.name] = (await client.callTool({ name: t.name, arguments: ARGS[t.name] })) as never;
    const body = (n: string) => JSON.parse(out[n]!.content.find((c) => c.type === "text")!.text!);
    expect(body("list_senses").sources).toHaveLength(2);
    expect(out.look!.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg", data: JPEG.toString("base64") });
    expect(out.listen!.isError).toBe(true); // the camera has no audio sense
    expect(body("listen").error.code).toBe("forbidden_sense");
    expect(body("read_environment").sources[0].readings[0]).toMatchObject({ value: 22.4, trend_last_hour: "rising", change_last_hour: 1.4 });
    expect(body("watch_for")).toMatchObject({ watch_id: "wat_1", expires_at: "2026-10-16T02:00:00Z" });
    expect(body("what_happened").events[0]).toMatchObject({ summary: "A courier left a parcel.", clip_url: "http://api/c" });
    expect(body("measure")).toMatchObject({ value: 2, unit: "count", echo: { measure: "count", what: { watch_id: "wat_1" }, period: "today" } });
    expect(body("check_history")).toMatchObject({ checks_used: 3, unchecked: 1, stored: 0, matches: [{ summary: "A person takes a pill." }] });
    expect(body("replay")).toMatchObject({ url: "http://api/playback/t/index.m3u8", clip_id: "clp_1" });
    expect(body("stop_watching")).toEqual({ stopped: "wat_1" });
  });

  it("answers a question with the image and the answer", async () => {
    const r = (await client.callTool({ name: "look", arguments: { source: "src_cam", question: "Is there a parcel?" } })) as { content: { type: string; text?: string }[] };
    expect(r.content[0]!.type).toBe("image");
    expect(JSON.parse(r.content[1]!.text!)).toMatchObject({ answer: "A parcel is on the step.", confidence: 0.9 });
  });
});

describe("remote mcp with oauth", () => {
  const app = createMcpService({ logger: false, apiUrl: "http://api/v1", publicUrl: "http://mcp.test", consoleUrl: "http://console.test", tokenSecret: "s", fetch: fakeApi });
  let base: string;
  beforeAll(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterAll(() => app.close());

  it("asks for auth with resource metadata", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('resource_metadata="http://mcp.test/.well-known/oauth-protected-resource"');
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(meta).toMatchObject({ code_challenge_methods_supported: ["S256"], registration_endpoint: "http://mcp.test/oauth/register" });
  });

  const redirect = "http://127.0.0.1:33418/callback";
  const form = (path: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  /** Register, then authorize: the browser lands on the console's consent page with a sealed request. */
  async function start(name = "Test client", state = "xyz") {
    const reg = await (await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: name }) })).json();
    const verifier = randomBytes(32).toString("base64url");
    const q = { client_id: reg.client_id, redirect_uri: redirect, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state };
    const auth = await fetch(`${base}/oauth/authorize?${new URLSearchParams(q)}`, { redirect: "manual" });
    expect(auth.status).toBe(302);
    const to = new URL(auth.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("http://console.test/connect");
    const request = new URLSearchParams(to.hash.slice(1)).get("request")!;
    return { reg, verifier, request };
  }
  /** What the console does: read the request, approve it at the API (faked), post the code to /oauth/approve. */
  async function approve(request: string, over: Partial<{ binding: string; client_name: string; redirect_host: string }> = {}) {
    const info = await (await fetch(`${base}/oauth/request?request=${encodeURIComponent(request)}`)).json();
    const code = `cc_${randomBytes(8).toString("hex")}`;
    approvals.set(code, { binding: info.binding, client_name: info.client_name, redirect_host: info.redirect_host, ...over });
    return form("/oauth/approve", { request, code });
  }
  const token = (body: Record<string, string>) => fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

  it("sends people to the console to consent, shows what is asking, and never takes a key from the browser", async () => {
    const { request } = await start("Claude Code");
    const r = await fetch(`${base}/oauth/request?request=${encodeURIComponent(request)}`);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const info = await r.json();
    expect(info).toMatchObject({ client_name: "Claude Code", redirect_host: "127.0.0.1:33418", verified: false });
    expect(info.binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(info)).not.toContain("callback"); // the full redirect URI and nonce stay sealed
    expect((await fetch(`${base}/oauth/request?request=junk`)).status).toBe(410);
    // /oauth/authorize takes no API key form.
    expect((await form("/oauth/authorize", { api_key: KEY })).status).toBe(404);
  });

  it("approves through the console, exchanges the code with PKCE, refreshes, and calls tools", async () => {
    const { reg, verifier, request } = await start();
    const ok = await approve(request);
    expect(ok.status).toBe(302);
    const back = new URL(ok.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get("state")).toBe("xyz");
    const code = back.searchParams.get("code")!;
    expect((await token({ grant_type: "authorization_code", code, code_verifier: "wrong", client_id: reg.client_id, redirect_uri: redirect })).status).toBe(400);
    const t = await (await token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect })).json();
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(t.access_token).not.toContain(KEY);
    const refreshed = await (await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: reg.client_id })).json();
    expect(refreshed.access_token).toBeTruthy();

    const client = new Client({ name: "remote", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${refreshed.access_token}` } } }));
    expect((await client.listTools()).tools).toHaveLength(10);
    const r = (await client.callTool({ name: "list_senses", arguments: {} })) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0]!.text).sources[0].id).toBe("src_cam");
    await client.close();
  });

  it("refuses approvals made for another request, and codes used twice", async () => {
    const { request } = await start("Claude Code");
    const other = await start("Evil");
    const otherInfo = await (await fetch(`${base}/oauth/request?request=${encodeURIComponent(other.request)}`)).json();
    // A code approved for one request can't finish another (the binding differs).
    const crossed = await approve(request, { binding: otherInfo.binding });
    expect(crossed.status).toBe(400);
    expect(await crossed.text()).toContain("Couldn&#39;t finish connecting");
    // Nor can a code approved under another name.
    expect((await approve(request, { client_name: "Claude" })).status).toBe(400);
    // An expired or forged request is a dead end, not a redirect.
    expect((await form("/oauth/approve", { request: "junk", code: "cc_x" })).status).toBe(410);
  });

  it("sends access_denied back when the person cancels", async () => {
    const { request } = await start("Claude Code", "s9");
    const no = await form("/oauth/deny", { request });
    expect(no.status).toBe(302);
    const back = new URL(no.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("s9");
    expect(back.searchParams.get("code")).toBeNull();
    expect((await form("/oauth/deny", { request: "junk" })).status).toBe(410);
  });

  it("allows a code to be redeemed once, and a replay revokes the tokens issued from it", async () => {
    const { reg, verifier, request } = await start();
    const ok = await approve(request);
    const code = new URL(ok.headers.get("location")!).searchParams.get("code")!;
    const exchange = () => token({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect });
    const first = await exchange();
    expect(first.status).toBe(200);
    const t = await first.json();
    const mcpStatus = async (tok: string) => (await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status;
    expect(await mcpStatus(t.access_token)).toBe(200);

    const replay = await exchange();
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
    expect(await mcpStatus(t.access_token)).toBe(401);
    const refresh = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token });
    expect(refresh.status).toBe(400);
  });

  it("also accepts a Senseplane API key directly", async () => {
    const client = new Client({ name: "key", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }));
    expect((await client.listTools()).tools).toHaveLength(10);
    await client.close();
  });
});
