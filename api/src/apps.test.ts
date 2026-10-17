// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Connected apps (ADR 0048): consent creates or reuses an app agent with its
// grants and a single-use connect code; the MCP service redeems the code for
// the app's key; abilities limit watches and history; disconnecting cuts it off.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, handleBrainEvent, type SenseplaneApi } from "./index.js";
import { appHost } from "./routes/apps.js";
import { createPasswordUser } from "./routes/auth.js";
import { requiredRole } from "./roles.js";
import { createTestDatabase } from "./testdb.js";

const PW = "correct horse battery";
const settle = () => new Promise((r) => setTimeout(r, 200));
const log = { warn() {}, error() {}, info() {} } as never;

describe("connected apps (ADR 0048)", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let owner: string;
  let cam: string;
  let sensor: string;

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html",
      auth: { signupOpen: false, password: true, consoleUrls: ["https://console.test"], sessionDays: 30, inviteDays: 7, attemptsPerMinute: 1000 },
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } } as never,
      bus: {
        async putSourceConfig() {}, async latestSnapshot() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); }, async putWatch() {}, async close() {},
        async request<T>(subject: string): Promise<T> {
          if (subject === "rpc.brain.compile") return { compiled: { trigger: { type: "objects", label: "person", on: "enter" }, cooldown_s: 60, active_hours: null }, estimate: {}, warnings: [], compiler: "rules", needs_zone: false } as T;
          throw new Error(subject);
        },
      },
    });
    acc = (await api.data.accounts.create("Apps")).id;
    await createPasswordUser(api.data, acc, "owner@example.test", PW);
    owner = (await api.public.inject({ method: "POST", url: "/auth/login", payload: { email: "owner@example.test", password: PW } })).json().session;
    cam = (await call(owner, "POST", "/v1/sources", { name: "Door", type: "browser", record_audio: true })).json().id;
    sensor = (await call(owner, "POST", "/v1/sources", { name: "Kitchen", type: "sensor" })).json().id;
  });
  afterAll(async () => {
    await settle();
    await api?.close();
    await drop?.();
  });

  const call = (key: string, method: string, url: string, payload?: object) =>
    api.public.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload } : {}) });
  /** What the MCP service does: a nonce sealed in its request, and its hash for the consent page. */
  const request = () => {
    const nonce = randomBytes(24).toString("base64url");
    return { nonce, binding: createHash("sha256").update(nonce).digest("base64url") };
  };
  const connect = (key: string, binding: string, over: object = {}) => call(key, "POST", "/v1/agents/connect", {
    client_name: "Claude Code", redirect_host: "127.0.0.1:33418", binding, source_ids: [cam], senses: ["video"], abilities: ["watch"], ...over,
  });
  const redeem = (body: object) => api.public.inject({ method: "POST", url: "/auth/connect/redeem", payload: body });

  it("normalises redirect hosts so loopback ports don't matter", () => {
    expect(appHost("127.0.0.1:33418")).toBe("localhost");
    expect(appHost("[::1]:5000")).toBe("localhost");
    expect(appHost("Claude.AI")).toBe("claude.ai");
    expect(appHost("mcp.example.com:8443")).toBe("mcp.example.com");
    expect(appHost("com.example.app:")).toBe("com.example.app:");
    expect(requiredRole("POST", "/v1/agents/connect")).toBe("admin");
  });

  it("approves an app, then the MCP service redeems the code once for its key", async () => {
    const r = request();
    const c = await connect(owner, r.binding);
    expect(c.statusCode).toBe(201);
    const body = c.json();
    expect(body).toMatchObject({ reused: false, agent: { name: "Claude Code", kind: "app", client_name: "Claude Code", redirect_host: "localhost", last_active_at: null } });
    expect(body.code).toMatch(/^cc_/);
    expect(JSON.stringify(body)).not.toMatch(/sk_/); // the browser never sees a key

    // The wrong nonce, name or host spends the code without a key.
    const wrong = await connect(owner, r.binding);
    expect((await redeem({ code: wrong.json().code, nonce: "nope", client_name: "Claude Code", redirect_host: "127.0.0.1:1" })).json().error.details.reason).toBe("mismatch");
    expect((await redeem({ code: wrong.json().code, nonce: r.nonce, client_name: "Claude Code", redirect_host: "127.0.0.1:1" })).json().error.details.reason).toBe("code_invalid");
    const other = await connect(owner, r.binding);
    expect((await redeem({ code: other.json().code, nonce: r.nonce, client_name: "Claude", redirect_host: "127.0.0.1:1" })).statusCode).toBe(400);

    // Each consent has its own code; the first one is still good (another loopback port is the same app).
    const ok = await redeem({ code: body.code, nonce: r.nonce, client_name: "Claude Code", redirect_host: "127.0.0.1:50123" });
    expect(ok.statusCode).toBe(200);
    const key = ok.json().api_key as string;
    expect((await call(key, "GET", "/v1/sources")).json().data.map((s: { id: string; senses: string[] }) => [s.id, s.senses])).toEqual([[cam, ["video"]]]);
    expect((await call(key, "GET", "/v1/account")).statusCode).toBe(403);
  });

  it("reuses the app on reconnect, replaces its access, and keeps a key per connection", async () => {
    const r1 = request();
    const first = (await connect(owner, r1.binding, { client_name: "Cursor", redirect_host: "127.0.0.1:4000" })).json();
    const k1 = await redeem({ code: first.code, nonce: r1.nonce, client_name: "Cursor", redirect_host: "127.0.0.1:4000" });
    expect(k1.statusCode).toBe(200);
    expect(k1.json()).toMatchObject({ agent_id: first.agent.id });
    const key1 = k1.json().api_key as string;
    expect(key1).toMatch(/^sk_/);
    expect((await redeem({ code: first.code, nonce: r1.nonce, client_name: "Cursor", redirect_host: "127.0.0.1:4000" })).json().error.details.reason).toBe("code_invalid");

    const r2 = request();
    const second = (await connect(owner, r2.binding, { client_name: "Cursor", redirect_host: "localhost:5001", senses: ["temperature", "humidity"], source_ids: [sensor], abilities: ["history"] })).json();
    expect(second.reused).toBe(true);
    expect(second.agent.id).toBe(first.agent.id);
    const key2 = (await redeem({ code: second.code, nonce: r2.nonce, client_name: "Cursor", redirect_host: "localhost:5001" })).json().api_key as string;
    const grants = (await call(owner, "GET", "/v1/grants")).json().data.filter((g: { agent_id: string }) => g.agent_id === first.agent.id);
    expect(grants).toEqual([expect.objectContaining({ source_ids: [sensor], senses: ["temperature", "humidity"], abilities: ["history"] })]);
    // Both machines stay connected and see the new access.
    for (const k of [key1, key2]) expect((await call(k, "GET", "/v1/sources")).json().data.map((s: { id: string }) => s.id)).toEqual([sensor]);
    const agents = async () => (await call(owner, "GET", "/v1/agents")).json().data.filter((a: { name: string }) => a.name === "Cursor");
    expect(await agents()).toHaveLength(1);
    // last_active_at is written after the response.
    await expect.poll(async () => (await agents())[0].last_active_at).not.toBeNull();

    // Another host is another app, even with the same name.
    const r3 = request();
    const phish = (await connect(owner, r3.binding, { client_name: "Cursor", redirect_host: "evil.example" })).json();
    expect(phish.reused).toBe(false);
    expect(phish.agent.id).not.toBe(first.agent.id);

    // Disconnecting revokes every key at once, and a later code for it can't be redeemed.
    const r4 = request();
    const late = (await connect(owner, r4.binding, { client_name: "Cursor", redirect_host: "127.0.0.1:1" })).json();
    expect((await call(owner, "DELETE", `/v1/agents/${first.agent.id}`)).statusCode).toBe(204);
    for (const k of [key1, key2]) expect((await call(k, "GET", "/v1/sources")).statusCode).toBe(401);
    expect((await redeem({ code: late.code, nonce: r4.nonce, client_name: "Cursor", redirect_host: "127.0.0.1:1" })).statusCode).toBe(404);
  });

  it("keeps at most five keys per app", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = request();
      const c = (await connect(owner, r.binding, { client_name: "Many", redirect_host: "claude.ai" })).json();
      keys.push((await redeem({ code: c.code, nonce: r.nonce, client_name: "Many", redirect_host: "claude.ai" })).json().api_key);
    }
    expect((await call(keys[0]!, "GET", "/v1/sources")).statusCode).toBe(401);
    expect((await call(keys[5]!, "GET", "/v1/sources")).statusCode).toBe(200);
    expect((await call(keys[1]!, "GET", "/v1/sources")).statusCode).toBe(200);
  });

  it("only admins and owners approve; agent keys can't", async () => {
    const inv = (await call(owner, "POST", "/v1/invites", { email: "m@example.test", role: "member" })).json();
    const token = new URLSearchParams(new URL(inv.invite_url).hash.slice(1)).get("invite")!;
    const member = (await api.public.inject({ method: "POST", url: `/auth/invites/${token}/accept`, payload: { password: PW } })).json().session;
    const r = await connect(member, request().binding);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("forbidden_role");
    const agent = (await call(owner, "POST", "/v1/agents", { name: "script" })).json();
    expect(agent).toMatchObject({ kind: "key", key_prefix: expect.any(String) });
    expect((await connect(agent.api_key, request().binding)).statusCode).toBe(403);
  });

  it("limits watches and history by ability", async () => {
    const r = request();
    const c = (await connect(owner, r.binding, { client_name: "Narrow", redirect_host: "narrow.example", senses: ["video"], abilities: [] })).json();
    const key = (await redeem({ code: c.code, nonce: r.nonce, client_name: "Narrow", redirect_host: "narrow.example" })).json().api_key as string;
    // Looking works; watches are refused.
    expect((await call(key, "GET", `/v1/sources/${cam}`)).statusCode).toBe(200);
    const w = await call(key, "POST", "/v1/watches", { instruction: "Tell me when someone comes", sources: [cam] });
    expect(w.statusCode).toBe(403);
    expect(w.json().error.message).toMatch(/watch/);
    // History: only the last two hours.
    const at = (ms: number) => new Date(Date.now() - ms);
    for (const [k, when] of [["old", at(5 * 3600_000)], ["new", at(60_000)]] as const) {
      await handleBrainEvent(api.data, undefined, "brain.event", {
        event_key: `${k}-${randomBytes(4).toString("hex")}`, account_id: acc, source_id: cam, type: "detection.person", sense: "video", occurred_at: when.toISOString(),
        labels: ["person"], confidence: 0.9, summary: `A person (${k}).`,
      }, log, async () => [[1, ...new Array(383).fill(0)]]);
    }
    const seen = (await call(key, "GET", `/v1/events?source=${cam}&from=${at(24 * 3600_000).toISOString()}`)).json().data.map((e: { summary: string }) => e.summary);
    expect(seen).toEqual(["A person (new)."]);
    const all = (await call(owner, "GET", `/v1/events?source=${cam}&from=${at(24 * 3600_000).toISOString()}`)).json().data;
    expect(all.length).toBeGreaterThanOrEqual(2);
    const old = `from=${at(5 * 3600_000).toISOString()}&to=${at(4 * 3600_000).toISOString()}`;
    expect((await call(key, "GET", `/v1/sources/${cam}/timeline?${old}`)).statusCode).toBe(403);
  });
});
