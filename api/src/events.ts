// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Events: created from the brain (Valkey) and from sensor readings, shaped as the
// public Event schema, and fanned out to webhooks.
import type { Selectable } from "kysely";
import type { AccountScope } from "./data/access.js";
import { newId } from "./data/ids.js";
import type { Destination, EventsTable } from "./data/schema.js";
import type { MediaClaims, PlaybackSigner } from "./playback.js";
import { deliveryKick, rememberEventTrace } from "./workers.js";

export type EventRow = Selectable<EventsTable>;

export interface NewEvent {
  event_key: string;
  source_id: string;
  type: string;
  sense: string;
  occurred_at: Date;
  summary: string;
  labels: string[];
  zones?: string[];
  confidence: number | null;
  /** watch.triggered: whether a vision model confirmed it (false: check skipped, no model). */
  verified?: boolean | null;
  value?: { sense: string; value: number; unit: string } | null;
  snapshot_key?: string | null;
  snapshot_bytes?: number | null;
  /** When to cut the event clip (video events); null for sensor events. */
  clip_due_at?: Date | null;
  watch_id?: string | null;
}

/** Inserts an event once per (account, event_key) and queues webhook deliveries. Returns undefined for a duplicate. */
export async function createEvent(s: AccountScope, e: NewEvent): Promise<EventRow | undefined> {
  const row = await s.db
    .insertInto("events")
    .values({
      id: newId("evt"), account_id: s.accountId, source_id: e.source_id, event_key: e.event_key, type: e.type, sense: e.sense,
      occurred_at: e.occurred_at, summary: e.summary, labels: e.labels, zones: e.zones ?? [], confidence: e.confidence, verified: e.verified ?? null,
      value: e.value ? JSON.stringify(e.value) : null, snapshot_key: e.snapshot_key ?? null, snapshot_bytes: e.snapshot_bytes ?? null, clip_due_at: e.clip_due_at ?? null,
      watch_id: e.watch_id ?? null,
    })
    .onConflict((oc) => oc.columns(["account_id", "event_key"]).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (!row) return undefined;
  rememberEventTrace(row.id); // webhook deliveries continue this event's trace
  const hooks = await s.db.selectFrom("webhooks").select(["id", "events"]).execute();
  const watch = row.type === "watch.triggered" && row.watch_id
    ? await s.db.selectFrom("watches").select("notify").where("id", "=", row.watch_id).executeTakeFirst()
    : undefined;
  const route = routeEvent(row.type, watch?.notify, hooks);
  if (route.webhooks.length) {
    await s.db
      .insertInto("webhook_deliveries")
      .values(route.webhooks.map((id) => ({ id: newId("dlv"), account_id: s.accountId, webhook_id: id, event_id: row.id })))
      .execute();
    // Wake the worker just after this transaction commits.
    setTimeout(() => deliveryKick.dispatchEvent(new Event("kick")), 20);
  }
  if (route.agents.length) {
    // Revoked agents are skipped; the watch keeps their ids.
    const live = await s.db.selectFrom("agents").select("id").where("id", "in", route.agents).where("revoked_at", "is", null).execute();
    if (live.length) {
      await s.db.insertInto("agent_inbox")
        .values(live.map((a) => ({ id: newId("inb"), account_id: s.accountId, agent_id: a.id, event_id: row.id, watch_id: row.watch_id })))
        .onConflict((oc) => oc.columns(["agent_id", "event_id"]).doNothing())
        .execute();
    }
  }
  return row;
}

/**
 * Where an event goes (ADR 0043). A watch.triggered event of a watch with
 * `notify` goes only to the listed webhooks (whatever event types they
 * subscribe to) and agents. Everything else, and watches without `notify`,
 * goes to every webhook subscribed to the type (or "*"). The Events feed
 * always has it.
 */
export function routeEvent(type: string, notify: Destination[] | null | undefined, hooks: { id: string; events: string[] }[]) {
  if (type === "watch.triggered" && notify?.length) {
    const want = new Set(notify.filter((d) => d.type === "webhook").map((d) => d.id));
    return {
      webhooks: hooks.filter((h) => want.has(h.id)).map((h) => h.id),
      agents: [...new Set(notify.filter((d) => d.type === "agent").map((d) => d.id))],
    };
  }
  return { webhooks: hooks.filter((h) => h.events.some((p) => typeMatches(p, type))).map((h) => h.id), agents: [] as string[] };
}

/**
 * An event type pattern: the type itself, "*" for everything, or a prefix
 * wildcard such as "detection.*" (every detection.<label>, whichever labels
 * the detector reports).
 */
export function typeMatches(pattern: string, type: string): boolean {
  if (pattern === "*" || pattern === type) return true;
  return pattern.endsWith(".*") && type.startsWith(pattern.slice(0, -1));
}

/** SQL for a type pattern: a prefix wildcard ("detection.*") becomes LIKE 'detection.%'. */
export function typeFilter(pattern: string): { op: "=" | "like"; value: string } {
  if (pattern.endsWith(".*")) return { op: "like", value: pattern.slice(0, -1).replace(/[\\%_]/g, (c) => `\\${c}`) + "%" };
  return { op: "=", value: pattern };
}

export interface EventUrls {
  signer: PlaybackSigner;
  base: string;
  ttlSeconds: number;
  /**
   * The caller's media claims for a source and time range (ADR 0036). Null when
   * the caller has no video grant there, in which case no media links are
   * returned. Absent for internal callers (webhooks are owner-level).
   */
  claims?: (sourceId: string, from: number, to: number) => MediaClaims | null;
}

/** The public Event shape (spec/schemas/event.json) with fresh signed media URLs. */
export function toEvent(row: EventRow, source: { name?: string; location: string | null } | undefined, urls?: EventUrls) {
  const media: { snapshot_url?: string; clip_url?: string } = {};
  const t = new Date(row.occurred_at).getTime();
  const end = row.ended_at ? new Date(row.ended_at).getTime() : t;
  const from = t - 5000;
  const to = Math.min(end + 10_000, t + 3600_000);
  const claims = urls?.claims ? urls.claims(row.source_id, from, to) : {};
  if (urls && claims) {
    if (row.snapshot_key) {
      media.snapshot_url = `${urls.base}/media/${urls.signer.sign({ kind: "object", accountId: row.account_id, key: row.snapshot_key, ...claims }, urls.ttlSeconds).token}/snapshot.jpg`;
    }
    if (row.clip_id) {
      media.clip_url = `${urls.base}/playback/${urls.signer.sign({ kind: "clip", accountId: row.account_id, clipId: row.clip_id, ...claims }, urls.ttlSeconds).token}/index.m3u8`;
    } else if (row.sense === "video" || row.sense === "audio") {
      // Until the event clip is cut, the URL plays the same window from raw segments.
      const scope = { kind: "range" as const, accountId: row.account_id, sourceId: row.source_id, from, to, ...claims };
      media.clip_url = `${urls.base}/playback/${urls.signer.sign(scope, urls.ttlSeconds).token}/index.m3u8`;
    }
  }
  return {
    id: row.id,
    type: row.type,
    ...(row.watch_id ? { watch_id: row.watch_id } : {}),
    source: { id: row.source_id, ...(source?.name ? { name: source.name } : {}), sense: row.sense, ...(source?.location ? { location: source.location } : {}) },
    occurred_at: new Date(row.occurred_at).toISOString(),
    ...(row.ended_at ? { ended_at: new Date(row.ended_at).toISOString() } : {}),
    summary: row.summary,
    labels: row.labels,
    ...(row.zones.length ? { zones: row.zones } : {}),
    confidence: row.confidence,
    verified: row.verified ?? null,
    value: row.value ?? null,
    media,
    ...(row.feedback ? { feedback: row.feedback } : {}),
  };
}
