// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Typed calls for endpoints the SDK doesn't wrap (conversations, /me,
// account limits, live view usage). On a server without an endpoint, callers
// get a SenseplaneError with status 404 and show an empty state (see `isUnavailable`).
import { SenseplaneError } from "senseplane";
import { readSse } from "./sse";

export interface Moment {
  source_id: string;
  source_name: string;
  at: string;
  label: string;
  snapshot_url: string;
  clip_url?: string;
}

export interface SuggestedWatch {
  instruction: string;
  sources: string[];
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  moments: Moment[];
  suggested_watch?: SuggestedWatch | null;
  /** Assistant messages: the reader's thumbs (null until given). */
  feedback?: Feedback | null;
  created_at: string;
}

export type Feedback = "helpful" | "not_helpful";

export interface Conversation {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface Me {
  user: { id: string; email: string; name?: string | null };
  role: "owner" | "admin" | "member" | "viewer";
  account: { id: string; name: string };
}

/** Allowances from the quota provider; null means unlimited. Self-host: live_view true, the rest null. */
export interface Limits {
  live_view: boolean;
  live_view_minutes: number | null;
  max_live_viewers: number | null;
  camera_minutes: number | null;
  storage_gb: number | null;
  ai_checks: number | null;
}

export interface AccountWithLimits {
  id: string;
  name: string;
  time_zone?: string | null;
  plan_label?: string | null;
  limits?: Limits;
  retention_days: number | null;
  retention_mode?: "days" | "fill";
}

export interface UsageWithLive {
  live_view_minutes?: number;
  /** People watching live right now across the workspace (ADR 0042). */
  live_viewers_now?: number;
  [k: string]: unknown;
}

export interface StreamHandlers {
  status?: (text: string) => void;
  delta?: (text: string) => void;
  moment?: (m: Moment) => void;
  suggestedWatch?: (w: SuggestedWatch) => void;
  done?: (m: Message) => void;
  error?: (message: string) => void;
}

export interface SendMessage {
  content: string;
  /** IANA zone for times in the answer (the console sends the browser's, matching the moment cards). */
  time_zone?: string;
  sources?: string[];
  from?: string;
  to?: string;
}

/** True when the endpoint isn't on this server (404 route, 501, or not_implemented). */
export function isUnavailable(e: unknown): boolean {
  return e instanceof SenseplaneError && (e.status === 404 || e.status === 501 || e.status === 405 || (e.code as string) === "not_implemented");
}

export function errorText(e: unknown): string {
  if (e instanceof SenseplaneError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function toError(res: Response): Promise<SenseplaneError> {
  const body = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string; request_id?: string; details?: Record<string, unknown> } };
  const e = body.error;
  return new SenseplaneError(res.status, (e?.code ?? "unknown") as never, e?.message ?? res.statusText, e?.request_id, e?.details);
}

export class ApiExtra {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      ...init,
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  readonly conversations = {
    list: () => this.request<{ data: Conversation[]; next_cursor: string | null }>("GET", "/conversations"),
    get: (id: string) => this.request<Conversation & { messages: Message[] }>("GET", `/conversations/${encodeURIComponent(id)}`),
    create: (title?: string) => this.request<Conversation>("POST", "/conversations", title ? { title } : {}),
    delete: (id: string) => this.request<void>("DELETE", `/conversations/${encodeURIComponent(id)}`),
    /** Thumbs on an answer; null clears them. */
    feedback: (id: string, messageId: string, value: Feedback | null) =>
      this.request<Message>("POST", `/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/feedback`, { value }),
    /**
     * Posts a message and streams the answer. Falls back to the JSON reply when
     * the server doesn't stream. Resolves with the final assistant message.
     */
    send: async (id: string, msg: SendMessage, on: StreamHandlers, signal?: AbortSignal): Promise<Message | undefined> => {
      const res = await this.fetchImpl(`${this.apiUrl}/conversations/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        signal,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(msg),
      });
      if (!res.ok) throw await toError(res);
      if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const m = (await res.json()) as Message;
        on.done?.(m);
        return m;
      }
      let final: Message | undefined;
      await readSse(res, ({ event, data }) => {
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(data);
        } catch {
          return;
        }
        if (event === "status") on.status?.(String(d.text ?? ""));
        else if (event === "delta") on.delta?.(String(d.text ?? ""));
        else if (event === "moment") on.moment?.(d as unknown as Moment);
        else if (event === "suggested_watch") on.suggestedWatch?.(d as unknown as SuggestedWatch);
        else if (event === "done") {
          final = (d.message ?? d) as Message;
          on.done?.(final);
        } else if (event === "error") {
          const err = d.error as { message?: string } | string | undefined;
          on.error?.(typeof err === "string" ? err : err?.message ?? "The answer could not be finished.");
        }
      });
      return final;
    },
  };

  me = () => this.request<Me>("GET", "/me");
  account = () => this.request<AccountWithLimits>("GET", "/account");
  usage = () => this.request<UsageWithLive>("GET", "/usage");
  /** Pause or resume a camera (ADR 0045); a server without it answers 404. */
  pauseSource = (id: string, paused: boolean) => this.request<unknown>("POST", `/sources/${encodeURIComponent(id)}/${paused ? "pause" : "resume"}`);
  /** Raw events page for counts (the SDK paginates through everything). */
  eventsPage = (q: Record<string, string>) => this.request<{ data: import("senseplane").Event[]; next_cursor: string | null }>("GET", `/events?${new URLSearchParams(q)}`);
}

/** Self-host defaults when the server doesn't report limits. */
export const DEFAULT_LIMITS: Limits = {
  live_view: true, live_view_minutes: null, max_live_viewers: null, camera_minutes: null, storage_gb: null, ai_checks: null,
};
