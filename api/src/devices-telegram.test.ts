// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Switching devices from a Telegram chat (ADR 0067, 0059) against a fake Bot
// API: the chat's agent switches within its Control grant, a lock waits for a
// person, who confirms with a button in a private chat but not in a group.
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ChannelDeps, handleTelegramUpdate, sendChannelMessage } from "./channels.js";
import { createApi, type SenseplaneApi } from "./index.js";
import { TelegramBot, type TelegramUpdate } from "./telegram.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

const log = { warn() {}, error() {}, info() {} } as never;
const CONFIG = { token: "123:secret-token", mode: "polling" as const, apiUrl: "https://tg.test" };

describe("devices from Telegram", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let owner: string;
  let deps: ChannelDeps;
  let bridge: { id: string; token: string };
  const sent: { method: string; params: Record<string, any> }[] = [];
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
  const say = (chat: { id: number; type: string }, text: string) => update({ message: { message_id: next, chat, from: { id: 42, first_name: "Ada" }, text } });
  const press = (chat: { id: number; type: string }, data: string) => update({ callback_query: { id: `q${next}`, data, message: { chat }, from: { id: 42, first_name: "Ada" } } });
  const PRIVATE = { id: 1001, type: "private", first_name: "Ada" };
  const GROUP = { id: -2002, type: "group", title: "Family" };
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      await api.data.withAccount(acc, (s) => s.db.updateTable("channels").set({ next_send_at: new Date(0) }).execute());
      const { rows } = await sql<{ id: string; account_id: string }>`select * from claim_channel_messages(${50}, ${60})`.execute(api.data.db());
      if (!rows.length) return;
      for (const r of rows) await sendChannelMessage(deps, r.id, r.account_id);
    }
  };
  const texts = (chat: number) => sent.filter((x) => x.method === "sendMessage" && String(x.params.chat_id) === String(chat)).map((x) => x.params);
  let running = true;

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", telegram: CONFIG, telegramFetch: fakeFetch,
      media: { control: fakeMediaPlane().client }, deviceTimings: { takeMs: 1500, waitMs: 3000, confirmMs: 60_000 } });
    deps = { data: api.data, app: api.public, bot: new TelegramBot(CONFIG, fakeFetch), log, decideConfirmation: api.decideConfirmation };
    acc = (await api.data.accounts.create("Home")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    bridge = (await call(owner, "POST", "/v1/bridges", { name: "Green" })).json();
    await call(bridge.token, "PUT", "/v1/bridge/entities", { entities: [
      { entity_id: "light.hall", name: "Hall light", area: "Hall", sense: "switch", kind: "state", controls: ["turn_on", "turn_off"] },
      { entity_id: "lock.front_door", name: "Front door", area: "Hall", sense: "lock", kind: "state", controls: ["lock", "unlock"] },
    ] });
    const chosen = (await call(owner, "PATCH", `/v1/bridges/${bridge.id}/entities`, { choose: ["light.hall", "lock.front_door"] })).json().data;
    await call(bridge.token, "POST", "/v1/bridge/health", { cameras: [], home_assistant: { connected: true } });
    for (const e of (await call(owner, "GET", "/v1/devices")).json().data) await call(owner, "PATCH", `/v1/devices/${e.id}`, { controllable: true });
    // A private chat and a group, linked; the private chat's agent is given Control on the hall's sensors.
    for (const chat of [PRIVATE, GROUP]) {
      const code = new URL((await call(owner, "POST", "/v1/channels/telegram/link")).json().url).searchParams.get("start")!;
      await say(chat, `/start ${code}`);
    }
    const chans = await api.data.withAccount(acc, (s) => s.db.selectFrom("channels").selectAll().execute());
    const priv = chans.find((c) => c.chat_id === String(PRIVATE.id))!;
    await call(owner, "POST", "/v1/grants", { agent_id: priv.agent_id, source_ids: [chosen[0].source_id], senses: ["sensors", "control"] });
    // The box turns things on and locks as asked.
    void (async () => {
      while (running) {
        const r = await call(bridge.token, "GET", "/v1/bridge/commands?wait=1");
        for (const c of (r.json().data ?? []) as { id: string; args: { action: string } }[]) {
          const state = c.args.action === "unlock" ? { locked: false } : c.args.action === "lock" ? { locked: true } : { on: c.args.action === "turn_on" };
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
    const list = texts(PRIVATE.id).at(-1)!;
    const buttons = list.reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[];
    const off = buttons.find((b) => b.text === "Hall light: Off")!;
    expect(off.callback_data).toMatch(/^dv:dev_[a-f0-9]+:turn_off$/);
    await press(PRIVATE, off.callback_data);
    await flush();
    expect(texts(PRIVATE.id).at(-1)!.text).toBe("Hall light is off.");
  });

  it("an unlock waits for a person: the private chat gets buttons, a group doesn't, and confirming runs it", async () => {
    await say(PRIVATE, "unlock the front door");
    await flush();
    const asked = texts(PRIVATE.id);
    expect(asked.some((m) => /Waiting for a person to confirm: unlock Front door/.test(m.text))).toBe(true);
    const prompt = asked.find((m) => /<b>Confirm\?<\/b>/.test(m.text))!;
    expect(prompt.text).toContain("asks to unlock Front door");
    const confirm = (prompt.reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[]).find((b) => b.text === "Confirm")!;
    const group = texts(GROUP.id).find((m) => /<b>Confirm\?<\/b>/.test(m.text))!;
    expect(group.reply_markup).toBeUndefined();
    expect(group.text).toContain("Confirm it in Senseplane");
    // Pressing it in the group does nothing.
    await press(GROUP, confirm.callback_data);
    expect(sent.find((x) => x.method === "answerCallbackQuery")!.params.text).toMatch(/in a group/);
    await press(PRIVATE, confirm.callback_data);
    await flush();
    expect(texts(PRIVATE.id).at(-1)!.text).toBe("Front door is unlocked.");
    const audit = (await call(owner, "GET", "/v1/audit?limit=100")).json().data as { action: string; details?: Record<string, unknown> }[];
    expect(audit.find((a) => a.action === "device.command_done" && a.details?.action === "unlock")!.details).toMatchObject({ via: "telegram", decided_by: "Ada in Telegram" });
  });
});
