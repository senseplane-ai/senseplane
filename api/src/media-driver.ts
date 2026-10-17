// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The API's media driver (ADR 0049): everything Senseplane asks of a media
// plane, in the contract's words (spec/media). At token time it ensures the
// camera's room and its feed egress (segments into the account's bucket via
// presigned PUTs, frames to the brain), then the caller mints the join token.
// It stops a feed when the camera has been offline for a while, is paused or
// deleted, or is out of allowance; the next token starts it again.
import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { DataAccess } from "./data/access.js";
import { type IngestSigner, roomFor } from "./ingest.js";
import { type ControlClient, MediaControlError } from "./media-client.js";

/** How often the media plane sends analysis frames: alerts wait on the batch, so this is part of every alert's latency. */
const FRAMES_BATCH_MS = 200;

export interface MediaOptions {
  /** The camera's room lives this long with nobody in it (keep above the feed stop delay). */
  roomEmptyTimeoutSeconds?: number;
  /** A feed is stopped after the camera has been offline this long (FEED_IDLE_STOP_SECONDS, default 600). */
  feedIdleStopSeconds?: number;
  /** Live viewers per camera (MEDIA_MAX_VIEWERS_PER_SOURCE). */
  maxViewersPerSource?: number;
}

export interface MediaControl {
  /** At token time: the camera's room and feed exist and run. Returns where clients signal. */
  prepareCamera(accountId: string, source: { id: string; record_audio: boolean }, opts?: { maxResolution?: "720p" | "1080p" }): Promise<{ signalUrl: string }>;
  /** Ends the camera's publisher session; the client gets roomClosed with `reason` (default expired). */
  disconnect?(sourceId: string, reason?: string): Promise<void>;
  /** Stops the camera's feed egress (paused, deleted, offline, out of allowance). */
  stopFeed?(accountId: string, sourceId: string, reason: string): Promise<void>;
  /** Live view: where viewers signal, and whether the camera publishes video right now. */
  liveState?(accountId: string, source: { id: string; record_audio: boolean }): Promise<{ signalUrl: string; streaming: boolean; viewers: number }>;
  /** Ends one live viewer (participant removal with the reason). */
  removeViewer?(sourceId: string, sessionId: string, reason: string): Promise<void>;
  /** The media plane's public base for WHIP URLs (MEDIA_PUBLIC_URL), when WHIP is offered. */
  publicUrl?: string;
}

export const CAMERA_IDENTITIES = (sourceId: string) => [`${sourceId}:capture`, `${sourceId}:whip`];
export const isViewer = (identity: string) => /:viewer:/.test(identity);
export const viewerSession = (identity: string) => identity.split(":viewer:")[1];

export function createMediaDriver(deps: {
  data: DataAccess;
  control: ControlClient;
  signer: IngestSigner;
  /** Where the media plane calls back: API_CALLBACK_URL, else the API's public URL. */
  callbackBase: string;
  publicUrl?: string;
  log: FastifyBaseLogger;
  options?: MediaOptions;
}): MediaControl & { sweepFeeds(): Promise<number> } {
  const o = deps.options ?? {};
  const idleStop = o.feedIdleStopSeconds ?? 600;
  const callbackUrl = `${deps.callbackBase.replace(/\/$/, "")}/internal/media/callbacks`;

  const ensureRoom = async (accountId: string, sourceId: string) => {
    const token = await deps.signer.signCallback({ accountId, sourceId, kind: "room" });
    const r = await deps.control.createRoom({
      roomId: roomFor(sourceId),
      // Longer than the feed's stop delay, so a camera back within it keeps its session (and gets a gap event).
      emptyTimeoutSeconds: o.roomEmptyTimeoutSeconds ?? idleStop + 60,
      maxParticipants: (o.maxViewersPerSource ?? 50) + 3,
      metadata: { account_id: accountId, source_id: sourceId },
      callback: { url: callbackUrl, token },
      options: { liveness: "any", codecs: ["h264", "opus"], onDuplicateIdentity: "replace", events: ["participant.joined", "participant.left", "producer.added", "producer.removed"] },
    });
    return r.signal_url;
  };

  /** The feed for this camera, started if it is not running (idempotent per sessionId). */
  const ensureFeed = async (accountId: string, source: { id: string; record_audio: boolean }, maxResolution?: "720p" | "1080p") => {
    const row = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("media_feeds").selectAll().where("source_id", "=", source.id).executeTakeFirst());
    if (row && !row.stopped_at) {
      const snap = await deps.control.getEgress(row.session_id).catch(() => undefined);
      if (snap && snap.status !== "finished" && snap.status !== "failed") return row.session_id;
    }
    const sessionId = `feed-${source.id}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    const metadata = { account_id: accountId, source_id: source.id };
    await deps.control.startEgress({
      sessionId,
      room: roomFor(source.id),
      joinToken: await deps.signer.signFeed({ sourceId: source.id, recordAudio: source.record_audio }),
      sinks: [
        {
          kind: "segments", keyPrefix: `raw/${accountId}/${source.id}/`, segmentSeconds: 6, destination: { type: "presign-callback" },
          audio: source.record_audio, metadata, ...(maxResolution ? { maxResolution } : {}),
        },
        { kind: "frames", fps: 5, batchMs: FRAMES_BATCH_MS, audio: source.record_audio, metadata },
      ],
      callback: { url: callbackUrl, token: await deps.signer.signCallback({ accountId, sourceId: source.id, kind: "feed", sessionId }) },
    });
    await deps.data.withAccount(accountId, (s) =>
      s.db.insertInto("media_feeds").values({ source_id: source.id, account_id: accountId, session_id: sessionId })
        .onConflict((oc) => oc.column("source_id").doUpdateSet({ session_id: sessionId, started_at: new Date(), stopped_at: null, stop_reason: null })).execute());
    deps.log.info({ accountId, sourceId: source.id, sessionId }, "camera feed started");
    return sessionId;
  };

  const stopFeed = async (accountId: string, sourceId: string, reason: string) => {
    const row = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("media_feeds").selectAll().where("source_id", "=", sourceId).where("stopped_at", "is", null).executeTakeFirst());
    if (!row) return;
    await deps.control.stopEgress(row.session_id).catch((err) => deps.log.warn({ err, sourceId }, "could not stop a feed; it ends with its room"));
    await deps.data.withAccount(accountId, (s) => s.db.updateTable("media_feeds").set({ stopped_at: new Date(), stop_reason: reason }).where("source_id", "=", sourceId).execute());
    deps.log.info({ accountId, sourceId, reason }, "camera feed stopped");
  };

  return {
    ...(deps.publicUrl ? { publicUrl: deps.publicUrl } : {}),
    async prepareCamera(accountId, source, opts) {
      const signalUrl = await ensureRoom(accountId, source.id);
      await ensureFeed(accountId, source, opts?.maxResolution);
      return { signalUrl };
    },
    async disconnect(sourceId, reason = "expired") {
      for (const identity of CAMERA_IDENTITIES(sourceId)) {
        await deps.control.removeParticipant(roomFor(sourceId), identity, reason).catch((err) => {
          if (!(err instanceof MediaControlError && err.status === 404)) deps.log.warn({ err, sourceId }, "could not disconnect a camera");
        });
      }
    },
    stopFeed,
    async liveState(accountId, source) {
      const signalUrl = await ensureRoom(accountId, source.id);
      const room = await deps.control.getRoom(roomFor(source.id));
      const participants = room?.status === "live" ? room.participants : [];
      const streaming = participants.some((p) => CAMERA_IDENTITIES(source.id).includes(p.identity) && p.publishing.some((x) => x.kind === "video"));
      return { signalUrl, streaming, viewers: participants.filter((p) => isViewer(p.identity)).length };
    },
    async removeViewer(sourceId, sessionId, reason) {
      await deps.control.removeParticipant(roomFor(sourceId), `${sourceId}:viewer:${sessionId}`, reason).catch((err) => deps.log.warn({ err, sourceId }, "could not end a live viewer"));
    },
    /** Stops feeds of cameras paused, or offline for longer than the stop delay. */
    async sweepFeeds() {
      const { sql } = await import("kysely");
      const rows = (await sql<{ account_id: string; source_id: string; reason: string }>`select * from feeds_to_stop(${idleStop})`.execute(deps.data.db())).rows;
      for (const r of rows) await stopFeed(r.account_id, r.source_id, r.reason);
      return rows.length;
    },
  };
}
