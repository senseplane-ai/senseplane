// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Persists brain output (spec/brain/valkey.json): events with their
// snapshots, and episode ends (which move the event clip window).
import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";
import type { DataAccess } from "./data/access.js";
import { newId } from "./data/ids.js";
import { createEvent } from "./events.js";
import type { ObjectStorage } from "./storage.js";

export interface BrainEvent {
  event_key: string;
  account_id: string;
  source_id: string;
  type: string;
  occurred_at: string;
  labels: string[];
  confidence: number;
  verified?: boolean | null;
  summary: string;
  zones?: string[];
  snapshot_jpeg_b64?: string;
}

const CLIP_AFTER_MS = 30_000; // segments around the event exist by then

/** Text that represents an event for memory search: what happened, where, and why we were watching. */
export function memoryText(summary: string, labels: string[], zones: string[], instruction?: string | null) {
  return [summary, labels.length ? `Seen: ${labels.join(", ")}.` : "", zones.length ? `Where: ${zones.join(", ").replace(/_/g, " ")}.` : "",
    instruction ? `Watch: ${instruction}` : ""].filter(Boolean).join(" ");
}

export async function handleBrainEvent(
  data: DataAccess, storage: ObjectStorage | undefined, subject: string, payload: Record<string, unknown>, log: FastifyBaseLogger,
  embed?: (texts: string[]) => Promise<number[][] | undefined>,
) {
  const accountId = String(payload.account_id ?? "");
  const sourceId = String(payload.source_id ?? "");
  if (!accountId || (!sourceId && subject !== "brain.usage")) return log.warn({ subject }, "brain message without account/source");
  if (subject === "brain.event") {
    const e = payload as unknown as BrainEvent;
    const known = await data.withAccount(accountId, (s) => s.sources.get(sourceId));
    if (!known) return log.warn({ sourceId }, "brain event for unknown source ignored");
    let snapshotKey: string | null = null;
    let snapshotBytes: number | null = null;
    if (e.snapshot_jpeg_b64 && storage) {
      snapshotKey = `snapshots/${accountId}/${sourceId}/${encodeURIComponent(e.event_key)}.jpg`;
      const jpeg = Buffer.from(e.snapshot_jpeg_b64, "base64");
      snapshotBytes = jpeg.length;
      await storage.put(snapshotKey, jpeg, "image/jpeg");
    }
    const occurred = new Date(e.occurred_at);
    const watchId = typeof payload.watch_id === "string" ? payload.watch_id : null;
    const created = await data.withAccount(accountId, async (s) => {
      const watch = watchId ? await s.db.selectFrom("watches").select(["id", "instruction", "sources"]).where("id", "=", watchId).executeTakeFirst() : undefined;
      // A watch on several cameras names the one that fired (ADR 0043).
      const summary = watch && watch.sources.length > 1 && !e.summary.startsWith(`${known.name}: `) ? `${known.name}: ${e.summary}` : e.summary;
      const row = await createEvent(s, {
        event_key: e.event_key, source_id: sourceId, type: e.type, sense: e.type === "sound.detected" ? "audio" : "video",
        occurred_at: occurred, summary, labels: e.labels, zones: e.zones, confidence: e.confidence,
        verified: e.type === "watch.triggered" && typeof e.verified === "boolean" ? e.verified : null,
        snapshot_key: snapshotKey, snapshot_bytes: snapshotBytes, clip_due_at: storage ? new Date(occurred.getTime() + CLIP_AFTER_MS) : null, watch_id: watch?.id ?? null,
      });
      if (row && e.type === "source.view_changed") {
        await s.db.updateTable("sources").set({ view_changed_at: occurred }).where("id", "=", sourceId).execute();
      }
      return row ? { row, instruction: watch?.instruction } : undefined;
    });
    if (created && embed) {
      const [vec] = (await embed([memoryText(e.summary, e.labels, e.zones ?? [], created.instruction)])) ?? [];
      if (vec) {
        await data.withAccount(accountId, (s) =>
          s.db.updateTable("events").set({ embedding: `[${vec.join(",")}]` }).where("id", "=", created.row.id).execute(),
        );
      }
    }
  } else if (subject === "brain.usage") {
    await data.withAccount(accountId, (s) =>
      s.db.insertInto("usage_records").values({
        account_id: accountId, source_id: typeof payload.source_id === "string" ? payload.source_id : null,
        kind: String(payload.kind), quantity: Number(payload.quantity), at: new Date(String(payload.at)),
        detail: typeof payload.detail === "string" ? payload.detail : null,
        dedupe_key: typeof payload.id === "string" ? `brain:${payload.id}` : null,
      }).onConflict((oc) => oc.columns(["account_id", "dedupe_key"]).where("dedupe_key", "is not", null).doNothing()).execute(),
    );
  } else if (subject === "brain.activity") {
    await storeActivity(data, accountId, sourceId, payload, log);
  } else if (subject === "brain.episode.closed") {
    const endedAt = new Date(String(payload.ended_at));
    await data.withAccount(accountId, (s) =>
      s.db.updateTable("events")
        .set({ ended_at: endedAt })
        .where("event_key", "=", String(payload.event_key))
        .execute()
        .then(() =>
          s.db.updateTable("events")
            .set({ clip_due_at: new Date(Math.max(endedAt.getTime() + 15_000, Date.now())) })
            .where("event_key", "=", String(payload.event_key))
            .where("clip_id", "is", null)
            .execute(),
        ),
    );
  }
}

const KINDS = new Set(["presence", "sound", "watch"]);

/**
 * One row per activity (ADR 0057): the open message creates it, heartbeats move last_seen_at, and the close
 * sets ended_at. Messages can arrive late or twice, so each field only moves forward; an activity the sweeper
 * closed while its brain was merely behind opens again on the next heartbeat.
 */
export async function storeActivity(data: DataAccess, accountId: string, sourceId: string, p: Record<string, unknown>, log: FastifyBaseLogger) {
  const kind = String(p.kind);
  const started = new Date(String(p.started_at));
  const lastSeen = new Date(String(p.last_seen_at ?? p.started_at));
  if (!KINDS.has(kind) || !p.activity_key || !p.label || Number.isNaN(started.getTime()) || Number.isNaN(lastSeen.getTime())) {
    return log.warn({ kind }, "malformed brain activity ignored");
  }
  const ended = typeof p.ended_at === "string" ? new Date(p.ended_at) : null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  await data.withAccount(accountId, async (s) => {
    if (!(await s.sources.get(sourceId))) return log.warn({ sourceId }, "brain activity for unknown source ignored");
    await s.db.insertInto("activities").values({
      id: newId("act"), account_id: accountId, source_id: sourceId, activity_key: String(p.activity_key), kind: kind as "presence",
      label: String(p.label).slice(0, 200), zone: str(p.zone), watch_id: str(p.watch_id), started_at: started, last_seen_at: lastSeen,
      ended_at: ended, peak_count: Math.max(0, Math.trunc(Number(p.peak_count) || 0)),
      confidence: typeof p.confidence === "number" ? p.confidence : null, verified: typeof p.verified === "boolean" ? p.verified : null,
      summary: str(p.summary)?.slice(0, 2000) ?? null,
    }).onConflict((oc) => oc.columns(["account_id", "activity_key"]).doUpdateSet({
      started_at: sql`least(activities.started_at, excluded.started_at)`,
      last_seen_at: sql`greatest(activities.last_seen_at, excluded.last_seen_at)`,
      // A close only moves the end later; a heartbeat newer than the end (the sweeper closed it while the brain
      // was only behind) opens it again; anything older changes nothing.
      ended_at: sql`CASE WHEN excluded.ended_at IS NOT NULL THEN greatest(activities.ended_at, excluded.ended_at, activities.started_at)
        WHEN excluded.last_seen_at > coalesce(activities.ended_at, activities.last_seen_at) THEN NULL ELSE activities.ended_at END`,
      peak_count: sql`greatest(activities.peak_count, excluded.peak_count)`,
      confidence: sql`greatest(activities.confidence, excluded.confidence)`,
      verified: sql`coalesce(excluded.verified, activities.verified)`,
      summary: sql`coalesce(excluded.summary, activities.summary)`,
    })).execute();
  });
}
