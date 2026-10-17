// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Typed fetch helper for endpoints the SDK does not cover: watch
// destinations and backtests, team and invites, /v1/me, workspace settings,
// account limits, and a few webhook actions (ADR 0047). When a server does not
// have an endpoint the call fails with `unavailable(e) === true` and the screen
// shows a clear state instead of breaking.
import { SenseplaneError, type Account, type Event, type Usage, type Watch, type Webhook, type components } from "senseplane";

export type AuditEntry = components["schemas"]["AuditEntry"];

export interface Ctx {
  apiUrl: string;
  apiKey: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const base = (u: string) => u.replace(/\/+$/, "");

/** `path` is relative to the API's /v1 base, e.g. "/members". */
export async function api<T>(ctx: Ctx, method: string, path: string, body?: unknown): Promise<T> {
  return request<T>(`${base(ctx.apiUrl)}${path}`, ctx.apiKey, method, body);
}

/** The auth routes live next to /v1 (…/auth/providers). */
export function authUrl(apiUrl: string): string {
  return base(apiUrl).replace(/\/v1$/, "") + "/auth";
}

async function request<T>(url: string, key: string, method: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, "network", e instanceof Error ? e.message : String(e));
  }
  const text = res.status === 204 ? "" : await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON (proxy error page) */
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? "unknown", err?.message ?? (res.statusText || `HTTP ${res.status}`), err?.details);
  }
  return json as T;
}

/** True when the server has no such endpoint (e.g. an older server). */
export function unavailable(e: unknown): boolean {
  const status = e instanceof ApiError || e instanceof SenseplaneError ? e.status : 0;
  if (status === 501 || status === 405) return true;
  if (status !== 404) return false;
  // A missing route answers "route not found"; a missing record names the record.
  const msg = e instanceof Error ? e.message : "";
  return /route not found/i.test(msg) || (e instanceof ApiError && e.code === "unknown");
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError || e instanceof SenseplaneError) {
    if (e.code === "forbidden") return "You don't have permission to do that.";
    if (e.code === "feature_not_available") return "This isn't available on this workspace.";
    if (e.code === "limit_reached") return `A limit was reached: ${e.message}`;
    return e.message || e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Lists every page of a cursor-paginated collection (up to `max` items). */
export async function listAll<T>(ctx: Ctx, path: string, max = 500): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const page: { data: T[]; next_cursor?: string | null } = await api(ctx, "GET", cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path);
    out.push(...page.data);
    cursor = page.next_cursor ?? null;
  } while (cursor && out.length < max);
  return out;
}

// --- watch destinations and backtests ---------------------------------------

export type Destination = { type: "webhook"; id: string } | { type: "agent"; id: string };
export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export interface ActiveHours {
  days: Day[];
  from: string;
  to: string;
  time_zone?: string;
}
export type WatchX = Watch & { notify?: Destination[]; active_hours?: ActiveHours | null; last_fired_at?: string | null };
export interface WatchInput {
  instruction?: string;
  sources?: string[];
  notify?: Destination[];
  active_hours?: ActiveHours | null;
  status?: "active" | "paused";
}
export interface WatchTestResult {
  matches: { source_id: string; source_name: string; at: string; summary: string; snapshot_url?: string }[];
  checks_used: number;
}

export const createWatch = (ctx: Ctx, body: WatchInput & { instruction: string; sources: string[] }) => api<WatchX>(ctx, "POST", "/watches", body);
export const updateWatch = (ctx: Ctx, id: string, body: WatchInput) => api<WatchX>(ctx, "PATCH", `/watches/${encodeURIComponent(id)}`, body);
export const testWatch = (ctx: Ctx, body: { instruction: string; sources: string[]; from: string; to: string }) => api<WatchTestResult>(ctx, "POST", "/watches/test", body);

// --- team --------------------------------------------------------------------

export type Role = "owner" | "admin" | "member" | "viewer";
export interface Me {
  user: { id: string; email: string; name?: string | null };
  role: Role;
  account: { id: string; name: string };
}
export interface Member {
  id: string;
  email: string;
  name?: string | null;
  role: Role;
  created_at?: string;
}
export interface Invite {
  id: string;
  email: string;
  role: Role;
  invite_url?: string;
  expires_at: string;
  created_at?: string;
}

export const getMe = (ctx: Ctx) => api<Me>(ctx, "GET", "/me");
export const listMembers = (ctx: Ctx) => listAll<Member>(ctx, "/members");
export const updateMember = (ctx: Ctx, id: string, role: Role) => api<Member>(ctx, "PATCH", `/members/${encodeURIComponent(id)}`, { role });
export const removeMember = (ctx: Ctx, id: string) => api<void>(ctx, "DELETE", `/members/${encodeURIComponent(id)}`);
export const listInvites = (ctx: Ctx) => listAll<Invite>(ctx, "/invites");
export const createInvite = (ctx: Ctx, email: string, role: Role) => api<Invite & { invite_url: string }>(ctx, "POST", "/invites", { email, role });
export const revokeInvite = (ctx: Ctx, id: string) => api<void>(ctx, "DELETE", `/invites/${encodeURIComponent(id)}`);

// --- account, limits and usage -----------------------------------------------

export interface Limits {
  live_view: boolean;
  live_view_minutes: number | null;
  max_live_viewers: number | null;
  camera_minutes: number | null;
  storage_gb: number | null;
  ai_checks: number | null;
}
export type AccountX = Account & {
  time_zone?: string | null;
  limits?: Limits;
  plan_label?: string | null;
  /** Optional: a deployment may expose a workspace-wide audio default. */
  record_audio_default?: boolean;
};
export interface AccountPatch {
  name?: string;
  time_zone?: string;
  retention_mode?: "days" | "fill";
  retention_days?: number | null;
  record_audio_default?: boolean;
}
export type UsageX = Omit<Usage, "by_day"> & {
  live_view_minutes?: number;
  live_view_minutes_by_source?: Record<string, number>;
  storage_gb_by_source?: Record<string, number>;
  ai_checks_by_source?: Record<string, number>;
  by_day?: { day: string; camera_minutes?: number; storage_gb_hours?: number; ai_checks?: number; live_view_minutes?: number }[];
};

export const getAccount = (ctx: Ctx) => api<AccountX>(ctx, "GET", "/account");
export const patchAccount = (ctx: Ctx, body: AccountPatch) => api<AccountX>(ctx, "PATCH", "/account", body);
export const getUsage = (ctx: Ctx, q: { from?: string; to?: string } = {}) => {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
  return api<UsageX>(ctx, "GET", `/usage${qs ? `?${qs}` : ""}`);
};

export interface AuthProviders {
  password: boolean;
  google: boolean;
  github: boolean;
  signup: boolean;
}
export async function getAuthProviders(ctx: Ctx): Promise<AuthProviders> {
  return request<AuthProviders>(`${authUrl(ctx.apiUrl)}/providers`, ctx.apiKey, "GET");
}

// --- webhooks: actions not in the SDK ----------------------------------------

export const updateWebhook = (ctx: Ctx, id: string, body: { url?: string; events?: string[] }) => api<Webhook>(ctx, "PATCH", `/webhooks/${encodeURIComponent(id)}`, body);
export const rotateWebhookSecret = (ctx: Ctx, id: string) => api<Webhook & { secret: string }>(ctx, "POST", `/webhooks/${encodeURIComponent(id)}/rotate-secret`);
export const testWebhook = (ctx: Ctx, id: string) => api<unknown>(ctx, "POST", `/webhooks/${encodeURIComponent(id)}/test`);

// --- events -------------------------------------------------------------------

export type EventX = Event & { source: Event["source"] & { name?: string } };

export interface EventPage {
  data: EventX[];
  next_cursor: string | null;
}
export function listEvents(ctx: Ctx, q: { source?: string; type?: string; from?: string; to?: string; cursor?: string; limit?: number }): Promise<EventPage> {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();
  return api<EventPage>(ctx, "GET", `/events${qs ? `?${qs}` : ""}`);
}
