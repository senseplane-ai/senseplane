// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Telegram channels (ADR 0059) against a fake Bot API: linking with a
// one-time code, alerts with a snapshot and buttons, muting, questions asked
// as the chat's agent, groups, a blocked bot, rate limits, unlinking, and the
// poller.
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ChannelDeps, handleTelegramUpdate, sendChannelMessage, telegramPollJob } from "./channels.js";
import { createEvent } from "./events.js";
import { type ApiBus, createApi, type SenseplaneApi } from "./index.js";
import type { ObjectStorage } from "./storage.js";
import { answerHtml, buttonUrlOk, fit, TelegramBot, telegramConfigFromEnv, type TelegramUpdate } from "./telegram.js";
import { createTestDatabase } from "./testdb.js";

const log = { warn() {}, error() {}, info() {} } as never;
const CONFIG = { token: "123:secret-token", mode: "polling" as const, apiUrl: "https://tg.test" };
const BOT = { id: 999, username: "SenseplaneTestBot", is_bot: true };

type Sent = { method: string; params: Record<string, any> };

describe("telegram helpers", () => {
  it("reads the config, and refuses webhook mode without a secret", () => {
    expect(telegramConfigFromEnv({})).toBeUndefined();
    expect(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: "1:a" })).toMatchObject({ mode: "polling", apiUrl: "https://api.telegram.org" });
    expect(() => telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: "1:a", TELEGRAM_MODE: "webhook" })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(telegramConfigFromEnv({ TELEGRAM_BOT_TOKEN: "1:a", TELEGRAM_MODE: "webhook", TELEGRAM_WEBHOOK_SECRET: "a".repeat(32) })?.mode).toBe("webhook");
  });
  it("turns an answer into Telegram HTML and fits it", () => {
    expect(answerHtml("**Twice** today <3 [1]")).toBe("<b>Twice</b> today &lt;3 [1]");
    const long = fit(`<b>${"x".repeat(5000)}</b>`, 4096);
    expect(long.length).toBeLessThanOrEqual(4096);
    expect(long.endsWith("…</b>")).toBe(true);
  });
  it("only uses button URLs Telegram accepts", () => {
    expect(buttonUrlOk("https://senseplane.example.com")).toBe(true);
    expect(buttonUrlOk("http://senseplane.example.com")).toBe(false);
    expect(buttonUrlOk("https://localhost")).toBe(false);
    expect(buttonUrlOk("https://192.168.1.4")).toBe(false);
  });
  it("never puts the token in an error", async () => {
    const bot = new TelegramBot(CONFIG, (async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 })) as typeof fetch);
    const err = await bot.getMe().catch((e: Error) => e);
    expect(String(err)).toContain("getMe");
    expect(String(err)).not.toContain("secret-token");
  });
});

describe("telegram channels", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let owner: string;
  let kitchen: string;
  let deps: ChannelDeps;
  const sent: Sent[] = [];
  const updates: TelegramUpdate[] = [];
  let failNext: { status: number; description: string; retry_after?: number } | undefined;
  const objects = new Map<string, Uint8Array>([["snapshots/k.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xd9])]]);
  let answer = "Someone came to the door **twice** today [1].";

  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const params: Record<string, any> = init?.body instanceof FormData
      ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"]))
      : JSON.parse(String(init?.body ?? "{}"));
    sent.push({ method, params });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (method === "getMe") return ok(BOT);
    if (method === "getUpdates") return ok(updates.splice(0));
    if (failNext && (method === "sendMessage" || method === "sendPhoto")) {
      const f = failNext;
      failNext = undefined;
      return new Response(JSON.stringify({ ok: false, description: f.description, parameters: f.retry_after ? { retry_after: f.retry_after } : undefined }), { status: f.status });
    }
    return ok({ message_id: sent.length });
  }) as typeof fetch;

  const storage: ObjectStorage = {
    async put(key, body) { objects.set(key, body); },
    async copy() {},
    async deleteMany(keys) { return keys.length; },
    async deletePrefix() { return 0; },
    async presign() { return undefined; },
    async get(key) {
      const body = objects.get(key);
      if (!body) throw new Error("no such key");
      return { body: (async function* () { yield body; })() } as never;
    },
  };
  // The brain answers by asking a question of the activity engine and citing the first event it can see.
  const bus: ApiBus = {
    async putSourceConfig() {}, async putWatch() {}, async latestSnapshot() { return undefined; }, async close() {},
    async request<T>(): Promise<T> { throw new Error("no rpc"); },
    async stream(_subject, payload, on) {
      const found = (await on.tool("list_events", {})) as { results: { event_id: string }[] };
      if (found.results[0]) await on.event({ type: "moment", moment: { kind: "event", event_id: found.results[0].event_id } });
      await on.event({ type: "done", content: answer, payload_sources: payload.sources });
    },
  };

  const call = (key: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  let nextUpdate = 1;
  const message = (chat: { id: number; type: string; title?: string; first_name?: string }, text: string, extra: Record<string, unknown> = {}) =>
    handleTelegramUpdate(deps, { update_id: nextUpdate++, message: { message_id: nextUpdate, chat, from: { id: 42, first_name: "Ada" }, text, ...extra } });
  const PRIVATE = { id: 1001, type: "private", first_name: "Ada" };
  const GROUP = { id: -2002, type: "group", title: "Family" };
  /** Sends everything queued, ignoring per-chat spacing. */
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      await api.data.withAccount(acc, (s) => s.db.updateTable("channels").set({ next_send_at: new Date(0) }).execute());
      const { rows } = await sql<{ id: string; account_id: string }>`select * from claim_channel_messages(${50}, ${60})`.execute(api.data.db());
      if (!rows.length) return;
      for (const r of rows) await sendChannelMessage(deps, r.id, r.account_id);
    }
  };
  const sentTo = (chat: number) => sent.filter((x) => (x.method === "sendMessage" || x.method === "sendPhoto") && String(x.params.chat_id) === String(chat));
  const linkCode = async () => new URL((await call(owner, "POST", "/v1/channels/telegram/link")).json().url).searchParams.get("start")!;
  const channelFor = (chat: number) => api.data.withAccount(acc, (s) => s.db.selectFrom("channels").selectAll().where("chat_id", "=", String(chat)).where("status", "=", "active").executeTakeFirst());
  const channel = (id: string) => api.data.withAccount(acc, (s) => s.db.selectFrom("channels").selectAll().where("id", "=", id).executeTakeFirstOrThrow());

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false, bus, storage,
      telegram: CONFIG, telegramFetch: fakeFetch, auth: { consoleUrls: ["https://senseplane.example.com"] },
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } } });
    deps = { data: api.data, app: api.public, storage, bot: new TelegramBot(CONFIG, fakeFetch), consoleUrl: "https://senseplane.example.com", log };
    acc = (await api.data.accounts.create("Mum's flat")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    kitchen = (await call(owner, "POST", "/v1/sources", { name: "Kitchen", type: "browser", record_audio: true })).json().id;
    await call(owner, "POST", "/v1/sources", { name: "Hallway", type: "browser" });
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });
  beforeEach(() => void sent.splice(0));

  it("says whether Telegram is set up", async () => {
    expect((await call(owner, "GET", "/v1/channels/telegram")).json()).toEqual({ configured: true, mode: "polling", username: "SenseplaneTestBot" });
  });

  it("links a private chat with a one-time code, as an agent that can ask about every camera", async () => {
    const link = (await call(owner, "POST", "/v1/channels/telegram/link")).json();
    expect(link.url).toMatch(/^https:\/\/t\.me\/SenseplaneTestBot\?start=[A-Za-z0-9_-]{32}$/);
    expect(link.group_url).toContain("startgroup=");
    const code = new URL(link.url).searchParams.get("start")!;
    await message(PRIVATE, `/start ${code}`);
    const ch = (await channelFor(PRIVATE.id))!;
    expect(ch).toMatchObject({ kind: "telegram", name: "Ada", chat_type: "private", status: "active", snapshots: true, can_ask: true });
    const agent = await api.data.withAccount(acc, (s) => s.db.selectFrom("agents").selectAll().where("id", "=", ch.agent_id).executeTakeFirstOrThrow());
    expect(agent).toMatchObject({ kind: "channel", name: "Telegram: Ada" });
    const [grant] = await api.data.withAccount(acc, (s) => s.db.selectFrom("grants").selectAll().where("agent_id", "=", ch.agent_id).execute());
    expect(grant!.source_ids).toHaveLength(2);
    expect(grant!.senses.sort()).toEqual(["audio", "video"]);
    expect(grant!.abilities).toEqual(["history"]);
    expect(ch.agent_key).not.toMatch(/^sk_/); // stored encrypted
    await flush();
    expect(sentTo(PRIVATE.id)[0]!.params.text).toContain("Linked to <b>Mum's flat</b>");
    // The code works once.
    await message(PRIVATE, `/start ${code}`);
    expect(sentTo(PRIVATE.id).at(-1)!.params.text).toMatch(/expired or was already used/);
    expect((await call(owner, "GET", "/v1/channels")).json().data).toEqual([expect.objectContaining({ id: ch.id, chat_type: "private", muted_until: null })]);
  });

  it("sends a watch's alert with its snapshot, a button to the recording and one to mute", async () => {
    const ch = (await channelFor(PRIVATE.id))!;
    const made = await call(owner, "POST", "/v1/watches", { instruction: "Tell me if someone is lying on the floor", sources: [kitchen], notify: [{ type: "channel", id: ch.id }],
      compiled: { trigger: { type: "objects", label: "person", on: "present", min_duration_s: 1 }, cooldown_s: 0, active_hours: null } });
    const watch = made.json();
    expect(made.statusCode, made.body).toBe(201);
    expect(watch.notify).toEqual([{ type: "channel", id: ch.id }]);
    expect((await call(owner, "POST", "/v1/watches", { instruction: "x y z", sources: [kitchen], notify: [{ type: "channel", id: "chn_nope" }],
      compiled: { trigger: { type: "objects", label: "person", on: "present" }, cooldown_s: 0, active_hours: null } })).statusCode).toBe(400);
    const at = new Date("2026-10-18T19:01:00Z");
    await api.data.withAccount(acc, (s) => createEvent(s, { event_key: "floor-1", source_id: kitchen, type: "watch.triggered", sense: "video", occurred_at: at,
      summary: "Someone is lying on the floor", labels: ["person"], confidence: 0.9, verified: true, watch_id: watch.id, snapshot_key: "snapshots/k.jpg" }));
    await flush();
    const [photo] = sentTo(PRIVATE.id);
    expect(photo!.method).toBe("sendPhoto");
    expect(photo!.params.photo).toBe("<file>");
    expect(photo!.params.caption).toBe("<b>Kitchen</b> · 19:01\nSomeone is lying on the floor"); // the workspace is in UTC
    const buttons = JSON.parse(photo!.params.reply_markup).inline_keyboard.flat();
    expect(buttons[0]).toEqual({ text: "View recording", url: `https://senseplane.example.com/cameras/${kitchen}?t=${encodeURIComponent("2026-10-18T19:00:55.000Z")}` });
    expect(buttons[1]).toEqual({ text: "Mute for 1 hour", callback_data: `mute:${ch.id}:3600` });

    // Snapshots off: text only.
    await call(owner, "PATCH", `/v1/channels/${ch.id}`, { snapshots: false });
    await api.data.withAccount(acc, (s) => createEvent(s, { event_key: "floor-2", source_id: kitchen, type: "watch.triggered", sense: "video", occurred_at: at,
      summary: "Someone is lying on the floor", labels: ["person"], confidence: 0.9, verified: false, watch_id: watch.id, snapshot_key: "snapshots/k.jpg" }));
    await flush();
    expect(sentTo(PRIVATE.id).at(-1)).toMatchObject({ method: "sendMessage", params: { text: expect.stringContaining("<i>Not checked by a model.</i>") } });

    // Mute from the button: the next alert is skipped.
    await handleTelegramUpdate(deps, { update_id: nextUpdate++, callback_query: { id: "cb1", data: `mute:${ch.id}:3600`, message: { chat: PRIVATE }, from: { id: 42 } } });
    expect(sent.find((x) => x.method === "answerCallbackQuery")!.params.text).toMatch(/paused/);
    const before = sentTo(PRIVATE.id).length;
    await api.data.withAccount(acc, (s) => createEvent(s, { event_key: "floor-3", source_id: kitchen, type: "watch.triggered", sense: "video", occurred_at: at,
      summary: "Someone is lying on the floor", labels: [], confidence: null, watch_id: watch.id }));
    await flush();
    expect(sentTo(PRIVATE.id)).toHaveLength(before);
    await message(PRIVATE, "/mute off");
    expect((await channelFor(PRIVATE.id))!.muted_until).toBeNull();
  });

  it("answers a question asked in the chat, as the chat's agent, with the moment as a button", async () => {
    await message(PRIVATE, "How many times did someone come to the door today?");
    await flush();
    const reply = sentTo(PRIVATE.id).at(-1)!;
    expect(reply.method).toBe("sendMessage"); // snapshots are off for this chat
    expect(reply.params.text).toBe("Someone came to the door <b>twice</b> today [1].");
    expect(JSON.parse(JSON.stringify(reply.params.reply_markup)).inline_keyboard[0][0].text).toMatch(/^\[1\] Kitchen \d\d:\d\d$/);
    expect(sent.some((x) => x.method === "sendChatAction")).toBe(true);
    const ch = (await channelFor(PRIVATE.id))!;
    const conv = await api.data.withAccount(acc, (s) => s.db.selectFrom("conversations").selectAll().where("id", "=", ch.conversation_id!).executeTakeFirstOrThrow());
    expect(conv.agent_id).toBe(ch.agent_id);
    // The next question continues the conversation.
    await message(PRIVATE, "And yesterday?");
    expect((await channelFor(PRIVATE.id))!.conversation_id).toBe(ch.conversation_id);
    await message(PRIVATE, "/new");
    expect((await channelFor(PRIVATE.id))!.conversation_id).toBeNull();
    // The audit log has the agent's requests.
    const audit = await api.data.withAccount(acc, (s) => s.db.selectFrom("audit_log").select("actor").where("actor", "=", `agent:${ch.agent_id}`).execute());
    expect(audit.length).toBeGreaterThan(0);
  });

  it("in a group, answers /ask and replies to the bot, and nothing else", async () => {
    await message(GROUP, `/start@SenseplaneTestBot ${await linkCode()}`);
    const ch = (await channelFor(GROUP.id))!;
    expect(ch).toMatchObject({ name: "Family", chat_type: "group" });
    await flush();
    expect(sentTo(GROUP.id)[0]!.params.text).toContain("start with /ask");
    sent.splice(0);
    await message(GROUP, "what's for dinner");
    await message(GROUP, "/ask@OtherBot something");
    await flush();
    expect(sentTo(GROUP.id)).toHaveLength(0);
    await message(GROUP, "/ask did anyone come to the door?");
    await message(GROUP, "and when?", { reply_to_message: { from: { id: BOT.id, is_bot: true } } });
    await flush();
    expect(sentTo(GROUP.id)).toHaveLength(2);
    // Questions off: the chat is told.
    await call(owner, "PATCH", `/v1/channels/${ch.id}`, { can_ask: false });
    await message(GROUP, "/ask anyone there?");
    await flush();
    expect(sentTo(GROUP.id).at(-1)!.params.text).toMatch(/Questions are turned off/);
  });

  it("stops sending to a chat that blocked the bot, and waits when Telegram says too many", async () => {
    const ch = (await channelFor(PRIVATE.id))!;
    failNext = { status: 429, description: "Too Many Requests: retry after 7", retry_after: 7 };
    await call(owner, "POST", `/v1/channels/${ch.id}/test`);
    await flush();
    const m = await api.data.withAccount(acc, (s) => s.db.selectFrom("channel_messages").selectAll().where("channel_id", "=", ch.id).orderBy("created_at", "desc").executeTakeFirstOrThrow());
    expect(m).toMatchObject({ status: "pending", attempts: 1, last_error: "rate limited" });
    expect(new Date(m.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 5000);
    await api.data.withAccount(acc, (s) => s.db.updateTable("channel_messages").set({ next_attempt_at: new Date(0) }).where("id", "=", m.id).execute());
    failNext = { status: 403, description: "Forbidden: bot was blocked by the user" };
    await flush();
    expect((await channel(ch.id)).status).toBe("blocked");
    expect((await call(owner, "POST", `/v1/channels/${ch.id}/test`)).statusCode).toBe(409);
    // Linking the chat again starts a new channel.
    await message(PRIVATE, `/start ${await linkCode()}`);
    expect((await api.data.withAccount(acc, (s) => s.db.selectFrom("channels").select("status").where("chat_id", "=", String(PRIVATE.id)).execute())).map((r) => r.status).sort())
      .toEqual(["active", "blocked"]);
  });

  it("limits how many questions one chat asks an hour", async () => {
    const ch = (await channelFor(PRIVATE.id))!;
    await call(owner, "PATCH", `/v1/channels/${ch.id}`, { can_ask: true });
    for (let i = 0; i < 30; i++) {
      await api.data.withAccount(acc, async (s) => {
        const c = await s.db.insertInto("conversations").values({ id: `cnv_lim${i}`, account_id: acc, agent_id: ch.agent_id, title: null }).returning("id").executeTakeFirstOrThrow();
        await s.db.insertInto("messages").values({ id: `msg_lim${i}`, account_id: acc, conversation_id: c.id, role: "user", content: "q" }).execute();
      });
    }
    await message(PRIVATE, "one more?");
    await flush();
    expect(sentTo(PRIVATE.id).at(-1)!.params.text).toMatch(/30 questions in the last hour/);
  });

  it("keeps agent keys out, and unlinks: no more alerts, and the chat's agent is revoked", async () => {
    const ch = (await channelFor(PRIVATE.id))!;
    const agentKey = api.data.box().decrypt(ch.agent_key);
    expect((await call(agentKey, "GET", "/v1/channels")).statusCode).toBe(403);
    expect((await call(agentKey, "GET", "/v1/sources")).statusCode).toBe(200);
    expect((await call(owner, "DELETE", `/v1/channels/${ch.id}`)).statusCode).toBe(204);
    expect((await call(agentKey, "GET", "/v1/sources")).statusCode).toBe(401);
    expect((await call(owner, "GET", "/v1/channels")).json().data.map((c: { id: string }) => c.id)).not.toContain(ch.id);
    // /stop in the group unlinks it too.
    await message(GROUP, "/stop");
    expect(await channelFor(GROUP.id)).toBeUndefined();
    expect(sent.at(-1)!.params.text).toMatch(/Unlinked from/);
  });

  it("polls Telegram for updates, storing each once, and keeps the offset", async () => {
    updates.push({ update_id: 500, message: { message_id: 1, chat: PRIVATE, from: { id: 42 }, text: "/help" } }, { update_id: 501, message: { message_id: 2, chat: PRIVATE, from: { id: 42 }, text: "/help" } });
    const job = telegramPollJob(deps);
    expect(await job.run(null)).toEqual({ offset: 502 });
    expect(sent.find((x) => x.method === "getUpdates")!.params).toMatchObject({ timeout: 25, allowed_updates: ["message", "callback_query", "my_chat_member"] });
    expect(await job.run({ offset: 502 })).toEqual({ offset: 502 });
    const { rows } = await sql<{ update_id: string }>`select * from claim_telegram_updates(${10}, ${60})`.execute(api.data.db());
    expect(rows.map((r) => Number(r.update_id)).sort()).toEqual([500, 501]);
  });

  it("answers the webhook only in webhook mode, with the secret", async () => {
    expect((await api.public.inject({ method: "POST", url: "/telegram/webhook", payload: { update_id: 1 } })).statusCode).toBe(404);
  });
});

describe("telegram with background workers on", () => {
  it("polls, links, and delivers an alert by itself", async () => {
    const t = await createTestDatabase();
    const sent: Sent[] = [];
    const pending: TelegramUpdate[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const params = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"])) : JSON.parse(String(init?.body ?? "{}"));
      sent.push({ method, params });
      const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      if (method === "getMe") return ok(BOT);
      if (method === "getUpdates") {
        await new Promise((r) => setTimeout(r, 200)); // a short long poll
        return ok(pending.splice(0));
      }
      return ok({ message_id: 1 });
    }) as typeof fetch;
    const api = await createApi({ database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", telegram: CONFIG, telegramFetch: fake,
      bus: { async putSourceConfig() {}, async putWatch() {}, async latestSnapshot() { return undefined; }, async close() {}, async request<T>(): Promise<T> { throw new Error("x"); }, async stream() {} },
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } } });
    try {
      const acc = (await api.data.accounts.create("Workers")).id;
      const key = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
      const call = (method: "GET" | "POST", url: string, payload?: unknown) => api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
      const src = (await call("POST", "/v1/sources", { name: "Door", type: "browser" })).json().id;
      const code = new URL((await call("POST", "/v1/channels/telegram/link")).json().url).searchParams.get("start");
      pending.push({ update_id: 1, message: { message_id: 1, chat: { id: 77, type: "private", first_name: "Bo" }, from: { id: 5 }, text: `/start ${code}` } });
      const until = async (f: () => Promise<boolean> | boolean, ms = 15_000) => {
        for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await f()) return true;
        return false;
      };
      expect(await until(async () => (await call("GET", "/v1/channels")).json().data.length === 1)).toBe(true);
      const ch = (await call("GET", "/v1/channels")).json().data[0];
      expect(await until(() => sent.some((x) => x.method === "sendMessage" && String(x.params.text).startsWith("Linked to")))).toBe(true);
      const w = (await call("POST", "/v1/watches", { instruction: "Tell me when someone is at the door", sources: [src], notify: [{ type: "channel", id: ch.id }],
        compiled: { trigger: { type: "objects", label: "person", on: "present" }, cooldown_s: 0, active_hours: null } })).json();
      await api.data.withAccount(acc, (s) => createEvent(s, { event_key: "w1", source_id: src, type: "watch.triggered", sense: "video", occurred_at: new Date(),
        summary: "Someone is at the door", labels: ["person"], confidence: 0.9, watch_id: w.id }));
      expect(await until(() => sent.some((x) => x.method === "sendMessage" && String(x.params.text).includes("Someone is at the door")))).toBe(true);
    } finally {
      await api.close();
      await t.drop();
    }
  }, 30_000);
});
