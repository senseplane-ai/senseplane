// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Channels (ADR 0059): Telegram chats that a watch's events go to, and that
// ask about the cameras. Linking: the console makes a one-time code, the
// person opens t.me/<bot>?start=<code>, and the bot's /start links that chat
// to the workspace as an agent of kind `channel` with a grant on its cameras.
// Questions go through the same conversation routes as any agent (app.inject
// with the channel's own key), so grants, limits and the audit log apply.
// Everything sent goes through the channel_messages outbox; updates coming in
// are stored once and handled by whichever API process claims them (ADR 0058).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { type Selectable, sql } from "kysely";
import { type AccountScope, type DataAccess, hashApiKey } from "./data/access.js";
import { newId } from "./data/ids.js";
import type { ChannelBody, ChannelsTable, EventsTable, StoredMoment } from "./data/schema.js";
import { ApiError } from "./errors.js";
import { type Job, startClaimLoop } from "./jobs.js";
import { wall } from "./local-time.js";
import type { AuditLog } from "./module.js";
import { insertGrant } from "./routes/trust.js";
import { type ObjectStorage, readObject } from "./storage.js";
import {
  answerHtml, buttonUrlOk, escapeHtml, fit, type InlineButton, type TelegramBot, TelegramError, type TelegramMessage, type TelegramUpdate,
} from "./telegram.js";

type Channel = Selectable<ChannelsTable>;
type EventRow = Selectable<EventsTable>;

/** Wakes this process's sender when it queued a message, and its update handler when it stored an update. */
export const channelKick = new EventTarget();
export const telegramKick = new EventTarget();
const kickSoon = (t: EventTarget) => setTimeout(() => t.dispatchEvent(new Event("kick")), 20);

const sameSecret = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const LINK_TTL_S = 10 * 60;
/** A question more than this after the last one starts a new conversation. */
const CONVERSATION_IDLE_MS = 30 * 60_000;
const QUESTIONS_PER_HOUR = 30;
const SEND_BACKOFF_S = [5, 15, 30, 60, 120, 300, 600];
const SEND_WINDOW_MS = 3600_000;
/** Telegram allows about one message a second in a private chat and 20 a minute in a group. */
const spacingMs = (chatType: string) => (chatType === "private" ? 1000 : 3000);
const MUTES: Record<string, number> = { "1h": 3600, "8h": 8 * 3600, "1d": 86400, "1w": 7 * 86400 };

export interface ChannelDeps {
  data: DataAccess;
  app: FastifyInstance;
  bot?: TelegramBot;
  storage?: ObjectStorage;
  /** Where buttons point (the camera's recording at that time); left out unless Telegram accepts the URL. */
  consoleUrl?: string;
  audit?: AuditLog;
  log: FastifyBaseLogger;
}

export const toChannel = (c: Channel) => ({
  id: c.id, kind: c.kind, name: c.name, chat_type: c.chat_type === "private" ? "private" : "group", status: c.status,
  snapshots: c.snapshots, can_ask: c.can_ask, muted_until: c.muted_until ? new Date(c.muted_until).toISOString() : null,
  agent_id: c.agent_id, created_at: new Date(c.created_at).toISOString(),
});

const chatName = (m: { chat: TelegramMessage["chat"] }) =>
  (m.chat.title || [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ") || m.chat.username || "Telegram").slice(0, 100);

/** Queues an event for the listed channels that are linked (createEvent, in the event's transaction). */
export async function queueEventForChannels(s: AccountScope, channelIds: string[], eventId: string): Promise<void> {
  if (!channelIds.length) return;
  const live = await s.db.selectFrom("channels").select("id").where("id", "in", channelIds).where("status", "=", "active").execute();
  if (!live.length) return;
  await s.db.insertInto("channel_messages").values(live.map((c) => ({ id: newId("cms"), account_id: s.accountId, channel_id: c.id, event_id: eventId }))).execute();
  kickSoon(channelKick);
}

async function queueBody(s: AccountScope, channelId: string, body: ChannelBody) {
  await s.db.insertInto("channel_messages").values({ id: newId("cms"), account_id: s.accountId, channel_id: channelId, body: JSON.stringify(body) }).execute();
  kickSoon(channelKick);
}

const hhmm = (t: Date | number, tz: string) => {
  const w = wall(t, tz);
  return `${String(w.hh).padStart(2, "0")}:${String(w.mm).padStart(2, "0")}`;
};
const recordingUrl = (base: string | undefined, sourceId: string, at: number) =>
  buttonUrlOk(base) ? `${base}/cameras/${sourceId}?t=${encodeURIComponent(new Date(at - 5000).toISOString())}` : undefined;

/** An event as a Telegram message: the camera and time, then the summary (a digest's first line in bold). */
export function eventMessage(e: EventRow, sourceName: string, tz: string, consoleUrl: string | undefined, channelId: string): ChannelBody {
  const [first, ...rest] = e.summary.split("\n");
  const head = `<b>${escapeHtml(sourceName)}</b> · ${hhmm(new Date(e.occurred_at), tz)}`;
  const lines = rest.length ? [`<b>${escapeHtml(first ?? "")}</b>`, ...rest.map(escapeHtml)] : [escapeHtml(first ?? "")];
  const unchecked = e.type === "watch.triggered" && e.verified === false ? "\n<i>Not checked by a model.</i>" : "";
  const url = recordingUrl(consoleUrl, e.source_id, new Date(e.occurred_at).getTime());
  const buttons: InlineButton[] = [...(url ? [{ text: "View recording", url }] : []), { text: "Mute for 1 hour", data: `mute:${channelId}:3600` }];
  return { text: `${head}\n${lines.join("\n")}${unchecked}`, buttons };
}

// --- sending -------------------------------------------------------------------

/** Sends one claimed outbox message. */
export async function sendChannelMessage(deps: ChannelDeps, id: string, accountId: string): Promise<void> {
  const { data } = deps;
  const job = await data.withAccount(accountId, async (s) => {
    const m = await s.db.selectFrom("channel_messages").selectAll().where("id", "=", id).where("status", "=", "pending").executeTakeFirst();
    if (!m) return undefined;
    const ch = await s.db.selectFrom("channels").selectAll().where("id", "=", m.channel_id).executeTakeFirstOrThrow();
    const ev = m.event_id ? await s.db.selectFrom("events").selectAll().where("id", "=", m.event_id).executeTakeFirst() : undefined;
    const src = ev ? await s.sources.get(ev.source_id) : undefined;
    const tz = (await s.account.get())?.time_zone || "UTC";
    return { m, ch, ev, src, tz };
  });
  if (!job) return;
  const { m, ch, ev } = job;
  const set = (v: Record<string, unknown>) => data.withAccount(accountId, (s) => s.db.updateTable("channel_messages").set({ claimed_until: null, ...v }).where("id", "=", id).execute());
  if (ch.status !== "active") return void (await set({ status: "skipped", last_error: `channel ${ch.status}` }));
  if (m.event_id && !ev) return void (await set({ status: "skipped", last_error: "event gone" }));
  if (ev && ch.muted_until && new Date(ch.muted_until) > new Date()) return void (await set({ status: "skipped", last_error: "muted" }));
  const body = ev ? { ...eventMessage(ev, job.src?.name ?? "Camera", job.tz, deps.consoleUrl, ch.id), ...(ch.snapshots && ev.snapshot_key ? { photo_key: ev.snapshot_key } : {}) } : m.body!;
  const attempts = m.attempts + 1;
  try {
    if (!deps.bot) throw new TelegramError("send", 0, "Telegram isn't set up on this server");
    await deliver(deps, ch, body);
    await set({ status: "sent", attempts, sent_at: new Date(), last_error: null });
    await data.withAccount(accountId, (s) => s.db.updateTable("channels").set({ next_send_at: new Date(Date.now() + spacingMs(ch.chat_type)) }).where("id", "=", ch.id).execute());
  } catch (err) {
    const e = err instanceof TelegramError ? err : new TelegramError("send", 0, (err as Error).message);
    if (e.chatGone) {
      await data.withAccount(accountId, (s) => s.db.updateTable("channels").set({ status: "blocked" }).where("id", "=", ch.id).execute());
      return void (await set({ status: "failed", attempts, last_error: e.description }));
    }
    if (e.status === 429) {
      const until = new Date(Date.now() + (e.retryAfter ?? 5) * 1000);
      await data.withAccount(accountId, (s) => s.db.updateTable("channels").set({ next_send_at: until }).where("id", "=", ch.id).execute());
      return void (await set({ attempts, next_attempt_at: until, last_error: "rate limited" }));
    }
    const delay = SEND_BACKOFF_S[Math.min(attempts - 1, SEND_BACKOFF_S.length - 1)]! * 1000;
    const giveUp = Date.now() - new Date(m.created_at).getTime() + delay > SEND_WINDOW_MS;
    deps.log.warn({ channel: ch.id, message: id, error: e.message, attempts }, "telegram send failed");
    await set({ status: giveUp ? "failed" : "pending", attempts, next_attempt_at: new Date(Date.now() + delay), last_error: e.description.slice(0, 300) });
  }
}

async function deliver(deps: ChannelDeps, ch: Channel, body: ChannelBody) {
  const bot = deps.bot!;
  const photo = body.photo_key && deps.storage ? await readObject(deps.storage, body.photo_key).catch(() => undefined) : undefined;
  if (photo) {
    try {
      if (body.text.length <= 1024) return void (await bot.sendPhoto(ch.chat_id, photo, body.text, body.buttons));
      await bot.sendPhoto(ch.chat_id, photo);
    } catch (err) {
      // A photo Telegram won't take still sends as text.
      if (!(err instanceof TelegramError) || err.status !== 400 || err.chatGone) throw err;
    }
  }
  await bot.sendMessage(ch.chat_id, fit(body.text, 4096), body.buttons);
}

export function startChannelSender(deps: ChannelDeps, intervalMs = 1000) {
  return startClaimLoop({
    name: "channels", intervalMs, log: deps.log, kick: channelKick, batch: 25,
    claim: async (max) => (await sql<{ id: string; account_id: string }>`select * from claim_channel_messages(${max}, ${60})`.execute(deps.data.db())).rows,
    handle: (r) => sendChannelMessage(deps, r.id, r.account_id),
  });
}

// --- updates coming in ---------------------------------------------------------

/** Stores an update once (webhook or poll) and wakes the handler. */
export async function storeTelegramUpdate(data: DataAccess, u: TelegramUpdate): Promise<void> {
  if (typeof u?.update_id !== "number") return;
  await sql`select store_telegram_update(${u.update_id}, ${JSON.stringify(u)}::jsonb)`.execute(data.db());
  kickSoon(telegramKick);
}

export function startTelegramUpdates(deps: ChannelDeps, intervalMs = 1000) {
  return startClaimLoop({
    name: "telegram-updates", intervalMs, log: deps.log, kick: telegramKick, batch: 10,
    claim: async (max) => (await sql<{ update_id: string; body: TelegramUpdate }>`select * from claim_telegram_updates(${max}, ${180})`.execute(deps.data.db())).rows,
    handle: async (r) => {
      await handleTelegramUpdate(deps, r.body);
      await sql`select finish_telegram_update(${r.update_id})`.execute(deps.data.db());
    },
  });
}

/** Polling mode: one long poll per run, so only one process asks Telegram at a time; the offset is the job's state. */
export function telegramPollJob(deps: ChannelDeps): Job {
  return {
    name: "telegram.poll", everyS: 1, leaseS: 60,
    run: async (state) => {
      const offset = (state as { offset?: number } | null)?.offset;
      let updates: TelegramUpdate[];
      try {
        updates = await deps.bot!.getUpdates(offset, 25);
      } catch (err) {
        // A webhook left over from webhook mode blocks polling.
        if (err instanceof TelegramError && err.status === 409) await deps.bot!.deleteWebhook();
        throw err;
      }
      for (const u of updates) await storeTelegramUpdate(deps.data, u);
      return { offset: updates.length ? updates.at(-1)!.update_id + 1 : offset };
    },
  };
}

/** Webhook mode: tells Telegram where to post updates, hourly (it is idempotent). */
export function telegramWebhookJob(deps: ChannelDeps, publicUrl: string): Job {
  return { name: "telegram.webhook", everyS: 3600, run: async () => void (await deps.bot!.setWebhook(`${publicUrl}/telegram/webhook`, deps.bot!.config.webhookSecret!)) };
}

const HELP = [
  "<b>Senseplane</b>",
  "Ask about your cameras in plain words, for example “How many times did someone come to the door today?”. In a group, start with /ask.",
  "",
  "/mute 1h, 8h, 1d or off: pause alerts in this chat",
  "/new: start a new conversation",
  "/use: choose the workspace, when this chat is linked to more than one",
  "/stop: unlink this chat",
].join("\n");

/** Handles one update. Command replies go straight back; alerts and answers go through the outbox. */
export async function handleTelegramUpdate(deps: ChannelDeps, u: TelegramUpdate): Promise<void> {
  const bot = deps.bot;
  if (!bot) return;
  const reply = (chatId: number | string, text: string) => bot.sendMessage(String(chatId), text).catch((err) => deps.log.warn({ err: (err as Error).message }, "telegram reply failed"));
  const linked = async (chatId: number | string) =>
    (await sql<{ account_id: string; id: string; account_name: string }>`select * from chat_channels(${"telegram"}, ${String(chatId)})`.execute(deps.data.db())).rows;

  if (u.my_chat_member) {
    // Removed from a group, or the person blocked the bot: stop sending there.
    if (["left", "kicked"].includes(u.my_chat_member.new_chat_member.status)) {
      for (const c of await linked(u.my_chat_member.chat.id)) {
        await deps.data.withAccount(c.account_id, (s) => s.db.updateTable("channels").set({ status: "blocked" }).where("id", "=", c.id).execute());
      }
    }
    return;
  }

  if (u.callback_query) {
    const q = u.callback_query;
    const [what, channelId, secs] = (q.data ?? "").split(":");
    const c = q.message ? (await linked(q.message.chat.id)).find((x) => x.id === channelId) : undefined;
    if (!c || (what !== "mute" && what !== "unmute")) return void (await bot.answerCallback(q.id, "This chat isn't linked any more.").catch(() => undefined));
    const until = what === "mute" ? new Date(Date.now() + Math.min(Number(secs) || 3600, 7 * 86400) * 1000) : null;
    await deps.data.withAccount(c.account_id, (s) => s.db.updateTable("channels").set({ muted_until: until }).where("id", "=", c.id).execute());
    await bot.answerCallback(q.id, until ? "Alerts paused for an hour. /mute off turns them back on." : "Alerts are on.").catch(() => undefined);
    return;
  }

  const m = u.message;
  if (!m?.text || m.from?.is_bot) return;
  const text = m.text.trim();
  const me = await bot.getMe();
  const [first = "", ...restWords] = text.split(/\s+/);
  const command = first.startsWith("/") ? first.slice(1).toLowerCase().replace(new RegExp(`@${me.username}$`, "i"), "") : undefined;
  if (command !== undefined && first.includes("@") && !first.toLowerCase().endsWith(`@${me.username.toLowerCase()}`)) return; // another bot's command
  const arg = restWords.join(" ").trim();
  const isPrivate = m.chat.type === "private";

  if (command === "start") {
    if (!arg) return void (await reply(m.chat.id, "To get alerts and ask questions here, open Senseplane → Settings → Notifications → <b>Connect Telegram</b>."));
    return linkChat(deps, m, arg, reply);
  }
  if (command === "help") return void (await reply(m.chat.id, HELP));

  const channels = await linked(m.chat.id);
  const current = channels[0];
  if (command === "stop") {
    if (!current) return void (await reply(m.chat.id, "This chat isn't linked."));
    await unlinkChannel(deps.data, current.account_id, current.id);
    const left = channels.length - 1;
    return void (await reply(m.chat.id, `Unlinked from <b>${escapeHtml(current.account_name)}</b>.${left ? ` Still linked to ${left} other workspace${left > 1 ? "s" : ""}; /stop again to unlink the next.` : " No more alerts will come here."}`));
  }
  if (command === "use") {
    if (channels.length < 2) return void (await reply(m.chat.id, channels.length ? `This chat is linked to <b>${escapeHtml(current!.account_name)}</b> only.` : "This chat isn't linked."));
    const pick = arg ? channels.find((c) => c.account_name.toLowerCase().startsWith(arg.toLowerCase())) : undefined;
    if (!pick) return void (await reply(m.chat.id, `Linked workspaces: ${channels.map((c) => `<b>${escapeHtml(c.account_name)}</b>`).join(", ")}. Send /use and a name to choose one.`));
    await deps.data.withAccount(pick.account_id, (s) => s.db.updateTable("channels").set({ selected_at: new Date() }).where("id", "=", pick.id).execute());
    return void (await reply(m.chat.id, `Questions now go to <b>${escapeHtml(pick.account_name)}</b>.`));
  }
  if (command === "mute") {
    if (!current) return void (await reply(m.chat.id, "This chat isn't linked."));
    const off = arg === "off";
    const secs = MUTES[arg || "1h"];
    if (!off && !secs) return void (await reply(m.chat.id, "Send /mute 1h, 8h, 1d, 1w or off."));
    const until = off ? null : new Date(Date.now() + secs! * 1000);
    for (const c of channels) await deps.data.withAccount(c.account_id, (s) => s.db.updateTable("channels").set({ muted_until: until }).where("id", "=", c.id).execute());
    return void (await reply(m.chat.id, off ? "Alerts are on." : `Alerts paused until ${until!.toISOString().slice(11, 16)} UTC. /mute off turns them back on.`));
  }
  if (command === "new") {
    if (current) await deps.data.withAccount(current.account_id, (s) => s.db.updateTable("channels").set({ conversation_id: null }).where("id", "=", current.id).execute());
    return void (await reply(m.chat.id, "Starting afresh."));
  }

  // A question: any text in a private chat; in a group, /ask or a reply to the bot (Telegram's privacy mode shows the bot nothing else).
  const addressed = command === "ask" || (command === undefined && (isPrivate || m.reply_to_message?.from?.id === me.id));
  if (!addressed) return;
  const question = command === "ask" ? arg : text;
  if (!current) return void (await reply(m.chat.id, "This chat isn't linked. Open Senseplane → Settings → Notifications → <b>Connect Telegram</b>."));
  if (!question) return void (await reply(m.chat.id, "Ask me something about your cameras, for example “/ask did anyone come to the door today?”"));
  await answerQuestion(deps, current.account_id, current.id, question);
}

async function linkChat(deps: ChannelDeps, m: TelegramMessage, code: string, reply: (chat: number, text: string) => Promise<unknown>) {
  const [link] = (await sql<{ account_id: string; kind: string; created_by: string | null }>`select * from redeem_channel_link(${hashApiKey(code)})`.execute(deps.data.db())).rows;
  if (!link || link.kind !== "telegram") return void (await reply(m.chat.id, "That link has expired or was already used. Make a new one in Senseplane: Settings → Notifications → <b>Connect Telegram</b>."));
  const name = chatName(m);
  const chatId = String(m.chat.id);
  const out = await deps.data.withAccount(link.account_id, async (s) => {
    const existing = await s.db.selectFrom("channels").selectAll().where("kind", "=", "telegram").where("chat_id", "=", chatId).where("status", "=", "active").executeTakeFirst();
    const account = (await s.account.get())!;
    if (existing) return { channel: existing, account, created: false };
    const agentId = newId("agt");
    await s.db.insertInto("agents").values({ id: agentId, account_id: link.account_id, name: `Telegram: ${name}`, kind: "channel" }).execute();
    const key = await s.apiKeys.create(`telegram ${name}`.slice(0, 120), agentId);
    // Every camera the workspace has now, with what each records; questions only (no watches). Changed on the Agents page.
    const sources = await s.sources.list();
    if (sources.length) {
      await insertGrant(s.db, async () => sources, link.account_id, agentId, {
        source_ids: sources.map((x) => x.id), senses: [...new Set(sources.flatMap((x) => x.senses))], abilities: ["history"],
      });
    }
    const channel = await s.db.insertInto("channels").values({
      id: newId("chn"), account_id: link.account_id, kind: "telegram", chat_id: chatId, chat_type: m.chat.type, name,
      agent_id: agentId, agent_key: deps.data.box().encrypt(key.key), linked_by: link.created_by,
      // A chat linked again picks up where it was chosen last.
      selected_at: new Date(),
    }).returningAll().executeTakeFirstOrThrow();
    const group = m.chat.type !== "private";
    await queueBody(s, channel.id, { text: [
      `Linked to <b>${escapeHtml(account.name)}</b>. Alerts from watches that send to this chat will arrive here.`,
      "",
      group
        ? "Anyone in this group can ask about the cameras: start with /ask, for example “/ask how many times did someone come to the door today?”"
        : "Ask me about your cameras, for example “How many times did someone come to the door today?”",
      "/help lists the rest.",
    ].join("\n") });
    return { channel, account, created: true };
  });
  if (!out.created) return void (await reply(m.chat.id, `This chat is already linked to <b>${escapeHtml(out.account.name)}</b>.`));
  await deps.audit?.write({
    accountId: link.account_id, actor: link.created_by ? `user:${link.created_by}` : "owner", action: "channel.linked", target: out.channel.id,
    details: { kind: "telegram", chat_type: m.chat.type, name },
  }).catch(() => undefined);
}

/** Unlinks a channel: no more alerts, and its agent (and so its questions) is revoked. */
export async function unlinkChannel(data: DataAccess, accountId: string, channelId: string): Promise<boolean> {
  return data.withAccount(accountId, async (s) => {
    const ch = await s.db.updateTable("channels").set({ status: "unlinked" }).where("id", "=", channelId).where("status", "!=", "unlinked").returningAll().executeTakeFirst();
    if (!ch) return false;
    await s.db.updateTable("agents").set({ revoked_at: new Date() }).where("id", "=", ch.agent_id).where("revoked_at", "is", null).execute();
    await s.db.updateTable("api_keys").set({ revoked_at: new Date() }).where("agent_id", "=", ch.agent_id).where("revoked_at", "is", null).execute();
    await s.db.deleteFrom("grants").where("agent_id", "=", ch.agent_id).execute();
    await s.db.updateTable("channel_messages").set({ status: "skipped", last_error: "unlinked" }).where("channel_id", "=", ch.id).where("status", "=", "pending").execute();
    return true;
  });
}

/** Asks as the channel's agent and queues the answer, with buttons to the moments it cites and a snapshot when there is one. */
async function answerQuestion(deps: ChannelDeps, accountId: string, channelId: string, question: string) {
  const { data, app } = deps;
  const ch = await data.withAccount(accountId, (s) => s.db.selectFrom("channels").selectAll().where("id", "=", channelId).executeTakeFirstOrThrow());
  const tell = (text: string) => data.withAccount(accountId, (s) => queueBody(s, ch.id, { text }));
  if (!ch.can_ask) return tell("Questions are turned off for this chat. An admin can turn them on in Senseplane → Settings → Notifications.");
  const asked = await data.withAccount(accountId, async (s) => Number((await s.db.selectFrom("messages").select((e) => e.fn.countAll().as("n"))
    .where("conversation_id", "in", s.db.selectFrom("conversations").select("id").where("agent_id", "=", ch.agent_id))
    .where("role", "=", "user").where("created_at", ">", new Date(Date.now() - 3600_000)).executeTakeFirstOrThrow()).n));
  if (asked >= QUESTIONS_PER_HOUR) return tell(`That's ${QUESTIONS_PER_HOUR} questions in the last hour, the most for one chat. Try again a little later.`);
  void deps.bot?.sendTyping(ch.chat_id).catch(() => undefined);

  const headers = { authorization: `Bearer ${data.box().decrypt(ch.agent_key)}` };
  const tz = (await data.withAccount(accountId, (s) => s.account.get()))?.time_zone || "UTC";
  const fresh = ch.conversation_id && ch.conversation_at && Date.now() - new Date(ch.conversation_at).getTime() < CONVERSATION_IDLE_MS;
  let conversation = fresh ? ch.conversation_id! : undefined;
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!conversation) {
      const made = await app.inject({ method: "POST", url: "/v1/conversations", headers, payload: { title: `Telegram: ${ch.name}`.slice(0, 200) } });
      if (made.statusCode === 401) return; // the agent was revoked: the chat is unlinked
      conversation = made.json().id as string;
    }
    res = await app.inject({ method: "POST", url: `/v1/conversations/${conversation}/messages`, headers, payload: { content: question.slice(0, 2000), time_zone: tz } });
    if (res.statusCode !== 404) break;
    conversation = undefined; // the conversation was deleted: start another
  }
  await data.withAccount(accountId, (s) => s.db.updateTable("channels").set({ conversation_id: conversation ?? null, conversation_at: new Date() }).where("id", "=", ch.id).execute());
  if (!res || res.statusCode >= 400) {
    const code = res?.json()?.error?.code;
    return tell(code === "allowance_exhausted" ? "This workspace has used its AI checks for now, so I can't answer until they reset."
      : res?.statusCode === 503 && /model/.test(res.json()?.error?.message ?? "") ? "No AI model is set up on this Senseplane yet, so I can't answer questions."
      : "I couldn't answer that just now. Try again in a moment.");
  }
  const message = res.json() as { id: string; content: string; moments: { source_id: string; source_name: string; at: string; event_id?: string }[] };
  const buttons = message.moments.slice(0, 3).flatMap((mo, i) => {
    const url = recordingUrl(deps.consoleUrl, mo.source_id, Date.parse(mo.at));
    return url ? [{ text: `[${i + 1}] ${mo.source_name} ${hhmm(Date.parse(mo.at), tz)}`, url }] : [];
  });
  const photo = ch.snapshots ? await data.withAccount(accountId, async (s) => {
    const row = await s.db.selectFrom("messages").select("moments").where("id", "=", message.id).executeTakeFirst();
    for (const mo of (row?.moments ?? []) as StoredMoment[]) {
      if (mo.kind === "look" && mo.snapshot_key) return mo.snapshot_key;
      if (mo.kind === "event") {
        const key = (await s.db.selectFrom("events").select("snapshot_key").where("id", "=", mo.event_id).executeTakeFirst())?.snapshot_key;
        if (key) return key;
      }
    }
    return undefined;
  }) : undefined;
  await data.withAccount(accountId, (s) => queueBody(s, ch.id, { text: answerHtml(message.content || "I don't have an answer for that."), ...(buttons.length ? { buttons } : {}), ...(photo ? { photo_key: photo } : {}) }));
}

// --- routes --------------------------------------------------------------------

export function registerChannelRoutes(deps: ChannelDeps) {
  const { app, data, bot } = deps;
  app.get("/v1/channels", async (req) => {
    const rows = await data.withAccount(req.accountId!, (s) => s.db.selectFrom("channels").selectAll().where("status", "!=", "unlinked").orderBy("created_at").execute());
    return { data: rows.map(toChannel), next_cursor: null };
  });

  app.get("/v1/channels/telegram", async () => {
    if (!bot) return { configured: false, mode: null, username: null };
    const me = await bot.getMe().catch(() => undefined);
    return { configured: true, mode: bot.config.mode, username: me?.username ?? null, ...(me ? {} : { error: "Telegram didn't accept the bot token, or can't be reached" }) };
  });

  app.post("/v1/channels/telegram/link", async (req, reply) => {
    if (!bot) throw new ApiError(503, "service_unavailable", "Telegram isn't set up on this server: set TELEGRAM_BOT_TOKEN");
    const me = await bot.getMe().catch(() => {
      throw new ApiError(503, "service_unavailable", "Telegram didn't accept the bot token, or can't be reached");
    });
    const code = randomBytes(24).toString("base64url"); // 32 characters, as Telegram's start parameter allows
    const expires = new Date(Date.now() + LINK_TTL_S * 1000);
    await data.withAccount(req.accountId!, (s) => s.db.insertInto("channel_links").values({
      id: newId("lnk"), account_id: req.accountId!, kind: "telegram", code_hash: hashApiKey(code), created_by: req.access?.userId ?? null, expires_at: expires,
    }).execute());
    return reply.code(201).send({
      url: `https://t.me/${me.username}?start=${code}`, group_url: `https://t.me/${me.username}?startgroup=${code}`,
      bot_username: me.username, expires_at: expires.toISOString(),
    });
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; snapshots?: boolean; can_ask?: boolean; muted_until?: string | null } }>("/v1/channels/:id", {
    schema: { body: { type: "object", additionalProperties: false, minProperties: 1, properties: {
      name: { type: "string", minLength: 1, maxLength: 100 }, snapshots: { type: "boolean" }, can_ask: { type: "boolean" },
      muted_until: { type: ["string", "null"], format: "date-time" },
    } } },
  }, async (req) => {
    const b = req.body;
    const row = await data.withAccount(req.accountId!, (s) => s.db.updateTable("channels").set({
      ...(b.name ? { name: b.name } : {}), ...(b.snapshots !== undefined ? { snapshots: b.snapshots } : {}), ...(b.can_ask !== undefined ? { can_ask: b.can_ask } : {}),
      ...("muted_until" in b ? { muted_until: b.muted_until ? new Date(b.muted_until) : null } : {}),
    }).where("id", "=", req.params.id).where("status", "!=", "unlinked").returningAll().executeTakeFirst());
    if (!row) throw new ApiError(404, "not_found", "channel not found");
    return toChannel(row);
  });

  app.delete<{ Params: { id: string } }>("/v1/channels/:id", async (req, reply) => {
    if (!(await unlinkChannel(data, req.accountId!, req.params.id))) throw new ApiError(404, "not_found", "channel not found");
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/channels/:id/test", async (req, reply) => {
    await data.withAccount(req.accountId!, async (s) => {
      const ch = await s.db.selectFrom("channels").select(["id", "status"]).where("id", "=", req.params.id).where("status", "!=", "unlinked").executeTakeFirst();
      if (!ch) throw new ApiError(404, "not_found", "channel not found");
      if (ch.status !== "active") throw new ApiError(409, "conflict", "Telegram says this chat blocked the bot or removed it; link it again");
      await queueBody(s, ch.id, { text: "<b>Senseplane</b>\nA test message: alerts from watches that send to this chat will arrive like this." });
    });
    return reply.code(202).send({ queued: true });
  });

  // Telegram's webhook (webhook mode). Outside /v1: Telegram proves itself with the secret it was given, not an API key.
  app.post<{ Body: TelegramUpdate }>("/telegram/webhook", { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const secret = bot?.config.mode === "webhook" ? bot.config.webhookSecret : undefined;
    const given = req.headers["x-telegram-bot-api-secret-token"];
    if (!secret || typeof given !== "string" || !sameSecret(given, secret)) throw new ApiError(404, "not_found", "route not found");
    await storeTelegramUpdate(data, req.body);
    return reply.send({});
  });
}
