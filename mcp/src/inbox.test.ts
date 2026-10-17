// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Agent inboxes through MCP (ADR 0043): watch_for routes to the agent itself,
// what_happened returns new inbox events first and marks them seen, and open
// sessions (in-memory/stdio and the HTTP GET stream) get notified.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { LoggingMessageNotificationSchema, ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { Senseplane } from "senseplane";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMcpServer } from "./handlers.js";
import { INBOX_URI, watchInbox } from "./inbox.js";
import { createMcpService } from "./service.js";

const AGENT = "sk_agent_key";
const OWNER = "sk_owner_key";
const SOURCES = [
  { id: "src_front", name: "Front door", type: "browser", senses: ["video"], status: "online" },
  { id: "src_back", name: "Back door", type: "browser", senses: ["video"], status: "online" },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let inbox: { id: string; watch_id: string; created_at: string; seen_at: string | null; event: Record<string, unknown> }[] = [];
const created: Record<string, unknown>[] = [];
const seen: string[][] = [];
const item = (n: number, source = SOURCES[0]!) => ({
  id: `inb_${n}`, watch_id: "wat_1", created_at: "2026-10-16T01:00:00Z", seen_at: null,
  event: { id: `evt_${n}`, type: "watch.triggered", source: { id: source.id, name: source.name, sense: "video" }, occurred_at: "2026-10-16T01:00:00Z",
    summary: `${source.name}: someone is at the door.`, labels: [], confidence: 0.9, value: null, media: { snapshot_url: `http://api/media/t${n}/snapshot.jpg` } },
});

const fakeApi: typeof fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  if (auth !== `Bearer ${AGENT}` && auth !== `Bearer ${OWNER}`) return json({ error: { code: "unauthorized", message: "bad key", request_id: "r" } }, 401);
  const p = url.pathname.replace(/^\/v1/, "");
  if (p === "/sources") return json({ data: SOURCES, next_cursor: null });
  if (p === "/inbox") {
    if (auth === `Bearer ${OWNER}`) return json({ error: { code: "validation_failed", message: "agent is required with an account key", request_id: "r" } }, 400);
    const unseen = url.searchParams.get("unseen") === "true";
    return json({ agent_id: "agt_1", data: inbox.filter((i) => !unseen || !i.seen_at).slice(0, Number(url.searchParams.get("limit") ?? 20)), next_cursor: null });
  }
  if (p === "/inbox/seen") {
    const b = await req.json();
    seen.push(b.ids);
    for (const i of inbox) if (b.ids.includes(i.id)) i.seen_at = "2026-10-16T02:00:00Z";
    return json({ marked: b.ids.length });
  }
  if (p === "/watches" && req.method === "POST") {
    const b = await req.json();
    created.push(b);
    return json({ id: "wat_1", instruction: b.instruction, sources: b.sources, mode: "alert", compiled: { trigger: { type: "objects", label: "person", on: "enter" }, cooldown_s: 0, active_hours: null },
      estimate: {}, status: "active", warnings: [], expires_at: null, notify: b.notify ?? [], active_hours: b.active_hours ?? null, created_at: "2026-10-16T01:00:00Z" }, 201);
  }
  if (p === "/memory/search") return json({ data: [] });
  return json({ error: { code: "not_found", message: p, request_id: "r" } }, 404);
};

const sdk = (key: string) => new Senseplane({ apiKey: key, baseUrl: "http://api/v1", fetch: fakeApi });
const body = (r: unknown) => JSON.parse((r as { content: { type: string; text: string }[] }).content.find((c) => c.type === "text")!.text);

async function connect(key: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(sdk(key), fakeApi);
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return { server, client };
}

beforeEach(() => {
  inbox = [];
  created.length = 0;
  seen.length = 0;
});

describe("inbox tools", () => {
  it("watch_for on several cameras by name sends the agent's watch to its own inbox", async () => {
    const { client } = await connect(AGENT);
    const out = body(await client.callTool({ name: "watch_for", arguments: {
      condition: "Tell me if someone comes to a door", sources: ["front door", "Back door"], active_hours: { from: "18:00", to: "06:00", time_zone: "Europe/London" },
    } }));
    expect(created[0]).toMatchObject({ sources: ["src_front", "src_back"], notify: [{ type: "agent", id: "agt_1" }], active_hours: { from: "18:00", to: "06:00" } });
    expect(out).toMatchObject({ notify: [{ type: "agent", id: "agt_1" }], sources: ["src_front", "src_back"] });
    expect(out.note).toMatch(/inbox/);
    await client.callTool({ name: "watch_for", arguments: { condition: "Tell me if someone comes", sources: ["Front door"], notify_me: false } });
    expect(created[1]!.notify).toBeUndefined();
  });

  it("an account key's watches report to the account's webhooks", async () => {
    const { client } = await connect(OWNER);
    const out = body(await client.callTool({ name: "watch_for", arguments: { condition: "Tell me if someone comes", sources: ["Front door"] } }));
    expect(created[0]!.notify).toBeUndefined();
    expect(out.note).toMatch(/webhooks/);
    expect(body(await client.callTool({ name: "what_happened", arguments: { question: "anything?" } })).new_from_your_watches).toBeUndefined();
  });

  it("what_happened returns new inbox events first and marks them seen", async () => {
    inbox = [item(1), item(2, SOURCES[1])];
    const { client } = await connect(AGENT);
    const first = body(await client.callTool({ name: "what_happened", arguments: { question: "Did anyone come?" } }));
    expect(Object.keys(first)).toEqual(["question", "new_from_your_watches", "events"]);
    expect(first.new_from_your_watches.map((e: any) => [e.source, e.summary])).toEqual([["Front door", "Front door: someone is at the door."], ["Back door", "Back door: someone is at the door."]]);
    expect(first.new_from_your_watches[0].snapshot_url).toBe("http://api/media/t1/snapshot.jpg");
    expect(seen).toEqual([["inb_1", "inb_2"]]);
    expect(body(await client.callTool({ name: "what_happened", arguments: { question: "Did anyone come?" } })).new_from_your_watches).toBeUndefined();

    inbox.push(item(3), item(4, SOURCES[1]));
    const back = body(await client.callTool({ name: "what_happened", arguments: { question: "Back?", source: "Back door" } }));
    expect(back.new_from_your_watches.map((e: any) => e.inbox_id)).toEqual(["inb_4"]); // only that camera's, the rest stay unseen
    expect(inbox.find((i) => i.id === "inb_3")!.seen_at).toBeNull();
  });

  it("lists and reads the inbox resource", async () => {
    inbox = [item(1)];
    const { client } = await connect(AGENT);
    expect((await client.listResources()).resources.map((r) => r.uri)).toEqual([INBOX_URI]);
    const read = await client.readResource({ uri: INBOX_URI });
    expect(JSON.parse(String((read.contents[0] as { text: string }).text)).events[0]).toMatchObject({ inbox_id: "inb_1", source: "Front door" });
    expect(seen).toEqual([]); // reading the resource doesn't mark anything seen
  });
});

describe("inbox notifications", () => {
  it("tells an open session about new items once", async () => {
    const { server, client } = await connect(AGENT);
    const logs: any[] = [];
    const updates: string[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void logs.push(n.params));
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => void updates.push(n.params.uri));
    await client.subscribeResource({ uri: INBOX_URI });
    const stop = watchInbox(server, sdk(AGENT), { intervalMs: 30 });
    await sleep(80);
    expect(logs).toEqual([]);
    inbox.push(item(1));
    await sleep(120);
    inbox.push(item(2));
    await sleep(120);
    stop();
    expect(logs.map((l) => l.data.events.map((e: any) => e.inbox_id))).toEqual([["inb_1"], ["inb_2"]]);
    expect(logs[0]).toMatchObject({ level: "notice", logger: "senseplane.inbox" });
    expect(updates).toEqual([INBOX_URI, INBOX_URI]);
  });

  it("stops quietly for an account key", async () => {
    const { server, client } = await connect(OWNER);
    const logs: unknown[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void logs.push(n.params));
    inbox.push(item(1));
    const stop = watchInbox(server, sdk(OWNER), { intervalMs: 20 });
    await sleep(100);
    stop();
    expect(logs).toEqual([]);
  });
});

describe("remote inbox notifications", () => {
  const app = createMcpService({ logger: false, apiUrl: "http://api/v1", publicUrl: "http://mcp.test", tokenSecret: "s", fetch: fakeApi });
  let base: string;
  beforeAll(async () => {
    process.env.MCP_INBOX_POLL_SECONDS = "0.05";
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    delete process.env.MCP_INBOX_POLL_SECONDS;
    await app.close();
  });

  it("pushes notifications on the GET stream", async () => {
    const client = new Client({ name: "remote", version: "1" });
    const logs: any[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void logs.push(n.params));
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${AGENT}` } } }));
    try {
      await sleep(200);
      inbox.push(item(7));
      for (let i = 0; i < 40 && !logs.length; i++) await sleep(50);
      expect(logs[0]?.data.events[0]).toMatchObject({ inbox_id: "inb_7", source: "Front door" });
    } finally {
      await client.close();
    }
  });

  it("still refuses a GET that isn't an event stream", async () => {
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${AGENT}` } })).status).toBe(405);
  });
});
