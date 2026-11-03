// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Switching devices from a Telegram chat (ADR 0067, 0059) against a fake Bot
// API: the chat's agent switches within its Control grant; Confirm buttons go
// only to private chats of people who are still members or above and whose
// chat can see the device, and are checked again when pressed; a person's own
// request in their chat is confirmed there, by them.
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ChannelDeps, handleTelegramUpdate, sendChannelMessage } from "./channels.js";
import { createApi, type SenseplaneApi } from "./index.js";
import { createPasswordUser } from "./routes/auth.js";
import { TelegramBot, type TelegramUpdate } from "./telegram.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

const log = { warn() {}, error() {}, info() {} } as never;
const CONFIG = { token: "123:secret-token", mode: "polling" as const, apiUrl: "https://tg.test" };
const PW = "correct horse battery";

describe("devices from Telegram", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let owner: string;
  let sam: string; // the owner's console session
  let kim: string; // an admin's
  let deps: ChannelDeps;
  let bridge: { id: string; token: string };
  let lock: string;
  let butler: string; // an agent key with Control
  const sent: { method: string; params: Record<string, any> }[] = [];
  const handed: { args: { entity_id: string; action: string } }[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop()!;
    sent.push({ method, params: JSON.parse(String(init?.body ?? "{}")) });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    return ok(method === "getMe" ? { id: 999, username: "TestBot", is_bot: true } : { message_id: sent.length });
  }) as typeof fetch;
  const call = (key: string, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  let next = 1;
  const update = (u: Omit<TelegramUpdate, "update_id">) => handleTelegramUpdate(deps, { update_id: next++, ...u });
  const say = (chat: { id: number; type: string }, text: string) => update({ message: { message_id: next, chat, from: { id: chat.id, first_name: "Ada" }, text } });
  const press = (chat: { id: number; type: string }, data: string) => update({ callback_query: { id: `q${next}`, data, message: { chat }, from: { id: chat.id, first_name: "Ada" } } });
  const PRIVATE = { id: 1001, type: "private", first_name: "Sam" }; // linked by Sam (owner)
  const GROUP = { id: -2002, type: "group", title: "Family" }; // linked by Sam
  const KIM = { id: 1003, type: "private", first_name: "Kim" }; // linked by Kim (admin)
  const GUEST = { id: 1004, type: "private", first_name: "Guest" }; // linked with a workspace key: nobody's
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      await api.data.withAccount(acc, (s) => s.db.updateTable("channels").set({ next_send_at: new Date(0) }).execute());
      const { rows } = await sql<{ id: string; account_id: string }>`select * from claim_channel_messages(${50}, ${60})`.execute(api.data.db());
      if (!rows.length) return;
      for (const r of rows) await sendChannelMessage(deps, r.id, r.account_id);
    }
  };
  const texts = (chat: number) => sent.filter((x) => x.method === "sendMessage" && String(x.params.chat_id) === String(chat)).map((x) => x.params);
  const confirmButton = (chat: number) => {
    const m = texts(chat).find((x) => x.reply_markup);
    return (m?.reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[] | undefined)?.find((b) => b.text === "Confirm");
  };
  const acks = () => sent.filter((x) => x.method === "answerCallbackQuery").map((x) => x.params.text as string);
  const unlocks = () => handed.filter((h) => h.args.entity_id === "lock.front_door").length;
  const status = async (id: string) => (await call(owner, "GET", `/v1/device-commands/${id}`)).json().status;
  let running = true;

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", telegram: CONFIG, telegramFetch: fakeFetch,
      auth: { signupOpen: false, password: true, consoleUrls: ["https://console.test"], sessionDays: 30, inviteDays: 7, attemptsPerMinute: 1000 } as never,
      media: { control: fakeMediaPlane().client }, deviceTimings: { takeMs: 1500, waitMs: 3000, confirmMs: 60_000 } });
    deps = { data: api.data, app: api.public, bot: new TelegramBot(CONFIG, fakeFetch), log, decideConfirmation: api.decideConfirmation };
    acc = (await api.data.accounts.create("Home")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    const login = async (email: string, role: "owner" | "admin") => {
      await createPasswordUser(api.data, acc, email, PW, role);
      return (await api.public.inject({ method: "POST", url: "/auth/login", payload: { email, password: PW } })).json().session as string;
    };
    sam = await login("sam@example.test", "owner");
    kim = await login("kim@example.test", "admin");
    bridge = (await call(owner, "POST", "/v1/bridges", { name: "Green" })).json();
    await call(bridge.token, "PUT", "/v1/bridge/entities", { entities: [
      { entity_id: "light.hall", name: "Hall light", area: "Hall", sense: "switch", kind: "state", controls: ["turn_on", "turn_off"] },
      { entity_id: "lock.front_door", name: "Front door", area: "Hall", sense: "lock", kind: "state", controls: ["lock", "unlock"] },
    ] });
    const chosen = (await call(owner, "PATCH", `/v1/bridges/${bridge.id}/entities`, { choose: ["light.hall", "lock.front_door"] })).json().data;
    const hall = chosen[0].source_id;
    await call(bridge.token, "POST", "/v1/bridge/health", { cameras: [], home_assistant: { connected: true } });
    for (const e of (await call(owner, "GET", "/v1/devices")).json().data) {
      await call(owner, "PATCH", `/v1/devices/${e.id}`, { controllable: true });
      if (e.entity_id === "lock.front_door") lock = e.id;
    }
    // A camera with sound, to check what a chat's first grant holds.
    await call(owner, "POST", "/v1/sources", { name: "Kitchen", type: "browser", record_audio: true });
    for (const [chat, by] of [[PRIVATE, sam], [GROUP, sam], [KIM, kim], [GUEST, owner]] as const) {
      const code = new URL((await call(by, "POST", "/v1/channels/telegram/link")).json().url).searchParams.get("start")!;
      await say(chat, `/start ${code}`);
    }
    const chans = await api.data.withAccount(acc, (s) => s.db.selectFrom("channels").selectAll().execute());
    const agentOf = (chat: { id: number }) => chans.find((c) => c.chat_id === String(chat.id))!.agent_id;
    await call(owner, "POST", "/v1/grants", { agent_id: agentOf(PRIVATE), source_ids: [hall], senses: ["sensors", "control"] });
    const b = (await call(owner, "POST", "/v1/agents", { name: "Butler" })).json();
    await call(owner, "POST", "/v1/grants", { agent_id: b.id, source_ids: [hall], senses: ["control"] });
    butler = b.api_key;
    // The box turns things on and locks as asked.
    void (async () => {
      while (running) {
        const r = await call(bridge.token, "GET", "/v1/bridge/commands?wait=1");
        for (const c of (r.json().data ?? []) as { id: string; args: { entity_id: string; action: string } }[]) {
          handed.push(c);
          const a = c.args.action;
          const state = a === "unlock" ? { locked: false } : a === "lock" ? { locked: true } : { on: a === "turn_on" };
          await call(bridge.token, "POST", `/v1/bridge/commands/${c.id}`, { ok: true, result: { reached: true, changed: true, state, before: {} } });
        }
      }
    })();
  });
  afterAll(async () => {
    running = false;
    await new Promise((r) => setTimeout(r, 1200));
    await api?.close();
    await drop?.();
  });
  beforeEach(() => void sent.splice(0));

  it("gives a newly linked chat neither listening nor Control: a person grants those", async () => {
    const grants = await api.data.withAccount(acc, (s) => s.db.selectFrom("grants").innerJoin("channels", "channels.agent_id", "grants.agent_id")
      .select(["grants.senses", "channels.chat_id"]).where("channels.chat_id", "=", String(KIM.id)).execute());
    const senses = grants.flatMap((g) => g.senses);
    expect(senses).toContain("video");
    expect(senses).not.toContain("audio");
    expect(senses).not.toContain("control");
  });

  it("switches the hall light when asked in a private chat, and says the state read back", async () => {
    await say(PRIVATE, "turn on the hall light");
    await flush();
    expect(texts(PRIVATE.id).at(-1)!.text).toBe("Hall light is on.");
  });

  it("refuses in a chat whose agent has no Control grant", async () => {
    await say(GROUP, "/ask turn off the hall light");
    await flush();
    expect(texts(GROUP.id).at(-1)!.text).toMatch(/no Control permission/);
  });

  it("lists devices with buttons, and a button switches one", async () => {
    await say(PRIVATE, "/devices");
    await flush();
    const buttons = texts(PRIVATE.id).at(-1)!.reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[];
    const off = buttons.find((b) => b.text === "Hall light: Off")!;
    expect(off.callback_data).toMatch(/^dv:dev_[a-f0-9]+:turn_off$/);
    await press(PRIVATE, off.callback_data);
    await flush();
    expect(texts(PRIVATE.id).at(-1)!.text).toBe("Hall light is off.");
  });

  it("a person's own unlock in their chat is confirmed there, by them, once; no other chat hears of it", async () => {
    const before = unlocks();
    await say(PRIVATE, "unlock the front door");
    await flush();
    expect(texts(PRIVATE.id).some((m) => /Confirm in this chat to unlock Front door/.test(m.text))).toBe(true);
    expect(texts(PRIVATE.id).find((m) => m.reply_markup)!.text).toMatch(/Are you sure\?/);
    const confirm = confirmButton(PRIVATE.id)!;
    for (const other of [GROUP, KIM, GUEST]) expect(texts(other.id)).toEqual([]);
    // A stale or forwarded button: the group can't, and a chat nobody qualifies for can't.
    await press(GROUP, confirm.callback_data);
    await press(GUEST, confirm.callback_data);
    expect(acks()).toEqual([expect.stringMatching(/in a group/), expect.stringMatching(/can't confirm/)]);
    await press(PRIVATE, confirm.callback_data);
    await flush();
    expect(texts(PRIVATE.id).at(-1)!.text).toBe("Front door is unlocked.");
    // A second tap does nothing.
    await press(PRIVATE, confirm.callback_data);
    await flush();
    expect(texts(PRIVATE.id).at(-1)!.text).toMatch(/already answered/);
    expect(unlocks() - before).toBe(1);
    const entries = await api.data.withAccount(acc, (s) => s.db.selectFrom("audit_log").select(["action", "details", "actor"]).where("action", "=", "device.command_done").execute());
    const done = entries.find((e) => (e.details as { action?: string })?.action === "unlock")!;
    expect(done.details).toMatchObject({ by: "sam@example.test", via: "telegram", decided_by: "sam@example.test in Telegram" });
    expect(done.actor).toMatch(/^user:/);
  });

  it("an agent's unlock goes to the private chats of members who can see the lock, checked again when pressed", async () => {
    const before = unlocks();
    const c = (await call(butler, "POST", `/v1/devices/${lock}/commands`, { action: "unlock" })).json();
    expect(c.status).toBe("awaiting_confirmation");
    await flush();
    expect(confirmButton(PRIVATE.id)?.callback_data).toBe(`cf:${c.id}:y`);
    expect(confirmButton(KIM.id)?.callback_data).toBe(`cf:${c.id}:y`);
    expect(texts(GROUP.id)).toEqual([]);
    expect(texts(GUEST.id)).toEqual([]);
    // Kim is made a viewer while it waits: her button no longer works.
    await createPasswordUser(api.data, acc, "kim@example.test", PW, "viewer");
    await press(KIM, `cf:${c.id}:y`);
    expect(acks().at(-1)).toMatch(/can't confirm/);
    expect(await status(c.id)).toBe("awaiting_confirmation");
    // A chat linked with a workspace key belongs to nobody.
    await press(GUEST, `cf:${c.id}:y`);
    expect(acks().at(-1)).toMatch(/can't confirm/);
    await press(PRIVATE, `cf:${c.id}:n`);
    await flush();
    expect(texts(PRIVATE.id).at(-1)!.text).toMatch(/said no/);
    expect(await status(c.id)).toBe("denied");
    expect(unlocks() - before).toBe(0);
    void sam;
  });
});
