// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The segment index and source status, from the media plane's feed events
// (spec/media/callbacks.json, delivered to /internal/media/callbacks), and
// the bus the API uses to reach its brains (Valkey, valkey.ts).
import type { FastifyBaseLogger } from "fastify";
import type { DataAccess } from "./data/access.js";

interface SegmentWritten {
  account_id: string;
  source_id: string;
  key: string;
  init_key: string;
  start: string;
  duration_ms: number;
  bytes: number;
  codec: string;
  has_audio?: boolean;
  /** How the media plane encrypted it (ADR 0066): the account key version and IV the API gave it. */
  encryption?: { method?: string; key_id?: string; iv?: string };
  width?: number;
  height?: number;
}

/** A segment's encryption as reported by the media plane; anything else is stored as in clear. */
function encryptionOf(e: SegmentWritten): { enc_version: number; enc_iv: Buffer } | Record<string, never> {
  const x = e.encryption;
  if (x?.method !== "aes-128" || !/^\d+$/.test(x.key_id ?? "") || !/^[0-9a-f]{32}$/i.test(x.iv ?? "")) return {};
  return { enc_version: Number(x.key_id), enc_iv: Buffer.from(x.iv!, "hex") };
}

export async function handleMediaEvent(data: DataAccess, subject: string, payload: Record<string, unknown>, log: FastifyBaseLogger) {
  const accountId = String(payload.account_id ?? "");
  const sourceId = String(payload.source_id ?? "");
  if (!accountId || !sourceId) return log.warn({ subject }, "media event without account/source");
  if (subject === "media.segment.written") {
    const e = payload as unknown as SegmentWritten;
    const ok = await data.withAccount(accountId, (s) =>
      s.segments.insert({
        source_id: sourceId, key: e.key, init_key: e.init_key, start_at: e.start, duration_ms: e.duration_ms,
        bytes: e.bytes, codec: e.codec, has_audio: e.has_audio ?? false,
        ...encryptionOf(e),
      }),
    );
    if (!ok) log.warn({ sourceId, accountId }, "segment for unknown source ignored");
    else await meterSegment(data, accountId, sourceId, e);
  } else if (subject === "media.source.online" || subject === "media.source.offline") {
    // Retried deliveries can arrive late: an older event never overrides a newer status.
    const at = typeof payload.at === "string" ? new Date(payload.at) : undefined;
    await data.withAccount(accountId, (s) => s.sources.setStatus(sourceId, subject.endsWith("online") ? "online" : "offline", at));
  }
}

export interface ApiBus {
  /** Publishes a source's zones and masks for the brain (hash sp:sources). */
  putSourceConfig(accountId: string, sourceId: string, config: Record<string, unknown>): Promise<void>;
  /** Publishes (or removes, with null) a watch for the brain (hash sp:watches). */
  putWatch(accountId: string, watchId: string, watch: Record<string, unknown> | null): Promise<void>;
  /** A request to any free brain (spec/brain/valkey.json "requests"; subject rpc.brain.<method>). */
  request<T>(subject: string, payload: unknown, timeoutMs?: number): Promise<T>;
  /** Does every live brain support this feature (its heartbeat's `features`, e.g. "blur", ADR 0068)? */
  supports?(feature: string): Promise<boolean>;
  latestSnapshot(accountId: string, sourceId: string): Promise<Uint8Array | undefined>;
  /**
   * A streamed brain request (rpc.brain.chat, ADR 0041): the brain pushes events and tool calls onto
   * the answer's list (valkey.ts brainStream). Resolves after `done` or `error`; rejects when the brain
   * doesn't take the request or goes quiet.
   */
  stream?(subject: string, payload: Record<string, unknown>, on: BrainStreamHandlers, limits?: { idleMs?: number; totalMs?: number }): Promise<void>;
  close(): Promise<void>;
}

export interface BrainStreamHandlers {
  /** Called in order, one at a time. */
  event(e: { type: string } & Record<string, unknown>): Promise<void> | void;
  tool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Camera time by resolution (ADR 0025); the segment key makes redeliveries harmless. */
export async function meterSegment(data: DataAccess, accountId: string, sourceId: string, e: { key: string; start: string; duration_ms: number; width?: number; height?: number }) {
  const long = Math.max(e.width ?? 0, e.height ?? 0);
  const short = Math.min(e.width ?? 0, e.height ?? 0);
  const detail = !long ? "other" : long <= 1280 && short <= 720 ? "720p" : long <= 1920 && short <= 1080 ? "1080p" : long <= 2560 && short <= 1440 ? "1440p" : "other";
  await data.withAccount(accountId, (s) =>
    s.db.insertInto("usage_records").values({
      account_id: accountId, source_id: sourceId, kind: "camera_ms", detail, quantity: e.duration_ms, at: new Date(e.start), dedupe_key: `seg:${e.key}`,
    }).onConflict((oc) => oc.columns(["account_id", "dedupe_key"]).where("dedupe_key", "is not", null).doNothing()).execute(),
  );
}
