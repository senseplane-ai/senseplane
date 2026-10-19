// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// A small Telegram Bot API client (ADR 0059). The token is part of every URL,
// so it never appears in errors or logs: they name the method only.

export interface TelegramConfig {
  token: string;
  /** polling: this server asks Telegram for updates (no public URL needed); webhook: Telegram posts them to /telegram/webhook. */
  mode: "polling" | "webhook";
  /** Required in webhook mode: Telegram sends it back in X-Telegram-Bot-Api-Secret-Token. */
  webhookSecret?: string;
  apiUrl: string;
}

export function telegramConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig | undefined {
  const token = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!token) return undefined;
  const mode = env.TELEGRAM_MODE === "webhook" ? "webhook" : "polling";
  const webhookSecret = (env.TELEGRAM_WEBHOOK_SECRET ?? "").trim() || undefined;
  if (mode === "webhook" && !webhookSecret) throw new Error("TELEGRAM_MODE=webhook needs TELEGRAM_WEBHOOK_SECRET");
  if (webhookSecret && !/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16–256 letters, digits, _ or -");
  return { token, mode, webhookSecret, apiUrl: (env.TELEGRAM_API_URL ?? "https://api.telegram.org").replace(/\/+$/, "") };
}

export class TelegramError extends Error {
  constructor(readonly method: string, readonly status: number, readonly description: string, readonly retryAfter?: number) {
    super(`telegram ${method}: ${status} ${description}`);
  }
  /** The chat is gone for this bot: blocked, kicked, deleted or never started. */
  get chatGone() {
    return this.status === 403 || (this.status === 400 && /chat not found|user is deactivated|group chat was (upgraded|deleted)|bot was kicked/i.test(this.description));
  }
}

export type InlineButton = { text: string; url?: string; data?: string };

export interface TelegramChat { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string }
export interface TelegramMessage {
  message_id: number; chat: TelegramChat; from?: { id: number; first_name?: string; username?: string; is_bot?: boolean };
  text?: string; reply_to_message?: { from?: { id: number; is_bot?: boolean } };
}
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; data?: string; message?: { chat: TelegramChat }; from: { id: number } };
  my_chat_member?: { chat: TelegramChat; new_chat_member: { status: string } };
}

const markup = (buttons?: InlineButton[]) => buttons?.length
  ? { inline_keyboard: buttons.map((b) => [b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }]) }
  : undefined;

export class TelegramBot {
  private me?: Promise<{ id: number; username: string }>;
  constructor(readonly config: TelegramConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async call<T>(method: string, params: Record<string, unknown> | FormData = {}, timeoutMs = 15_000): Promise<T> {
    const form = params instanceof FormData;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.apiUrl}/bot${this.config.token}/${method}`, {
        method: "POST",
        headers: form ? undefined : { "content-type": "application/json" },
        body: form ? params : JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new TelegramError(method, 0, (err as Error).name === "TimeoutError" ? "timed out" : "could not reach Telegram");
    }
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    if (!res.ok || !body.ok) throw new TelegramError(method, res.status, body.description ?? "error", body.parameters?.retry_after);
    return body.result as T;
  }

  /** The bot's own username (cached); a failure isn't cached. */
  getMe(): Promise<{ id: number; username: string }> {
    this.me ??= this.call<{ id: number; username: string }>("getMe").catch((err) => {
      this.me = undefined;
      throw err;
    });
    return this.me;
  }

  sendMessage(chatId: string, text: string, buttons?: InlineButton[]) {
    return this.call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: markup(buttons) });
  }

  sendPhoto(chatId: string, jpeg: Buffer, caption?: string, buttons?: InlineButton[]) {
    const f = new FormData();
    f.set("chat_id", chatId);
    f.set("photo", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "snapshot.jpg");
    if (caption) {
      f.set("caption", caption);
      f.set("parse_mode", "HTML");
    }
    const m = markup(buttons);
    if (m) f.set("reply_markup", JSON.stringify(m));
    return this.call("sendPhoto", f, 30_000);
  }

  sendTyping(chatId: string) {
    return this.call("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  answerCallback(id: string, text: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  getUpdates(offset: number | undefined, timeoutS: number) {
    return this.call<TelegramUpdate[]>("getUpdates", { offset, timeout: timeoutS, allowed_updates: ALLOWED_UPDATES }, (timeoutS + 10) * 1000);
  }

  setWebhook(url: string, secret: string) {
    return this.call("setWebhook", { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES });
  }

  deleteWebhook() {
    return this.call("deleteWebhook", {});
  }
}

export const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"];

/** Text for Telegram's HTML mode. */
export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A model's answer (light Markdown) as Telegram HTML: bold and code kept, everything else escaped. */
export function answerHtml(markdown: string): string {
  return escapeHtml(markdown)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
}

/** Cuts text to Telegram's limits (4096 for a message, 1024 for a caption) without breaking an entity or a tag. */
export function fit(html: string, max: number): string {
  if (html.length <= max) return html;
  let cut = html.slice(0, max - 20); // room for the ellipsis and closing tags
  cut = cut.replace(/<[^>]*$/, "").replace(/&[a-z]*$/, "");
  // Close any tag the cut left open.
  const open = [...cut.matchAll(/<(\/?)(b|code)>/g)].reduce((stack, m) => (m[1] ? stack.slice(0, -1) : [...stack, m[2]!]), [] as string[]);
  return `${cut}…${open.reverse().map((t) => `</${t}>`).join("")}`;
}

/** Whether Telegram accepts a URL for a button: https on a public-looking host (not localhost or an IP). */
export function buttonUrlOk(url: string | undefined): url is string {
  if (!url || !URL.canParse(url)) return false;
  const u = new URL(url);
  return u.protocol === "https:" && u.hostname.includes(".") && !/^[\d.]+$/.test(u.hostname) && !u.hostname.endsWith(".localhost") && !u.hostname.endsWith(".local");
}
