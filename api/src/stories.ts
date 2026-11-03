// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Multi-camera stories (ADR 0070). A story is many moments (events, time
// ranges on cameras, or what a search finds) put in time order and made into
// one video. Nothing is re-encoded: each piece is its recorded segments,
// copied (and encrypted again with a key of the story's own, ADR 0066) under
// stories/{account}/{story}/, so it outlives the raw recordings like a saved
// clip. A labelled story (the default) also gets captions with each piece's
// camera and time, and a long gap said in the next caption: a WebVTT track
// for the player and a subtitle track in each downloadable MP4 part. Fast
// mode is the copy alone. A background job (ADR 0058) makes it.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { type Selectable, sql } from "kysely";
import { grantFilter, requireRange, sensesForRange } from "./access.js";
import { blurredOnly } from "./blur.js";
import type { DataAccess } from "./data/access.js";
import { newId } from "./data/ids.js";
import type { Database, StoriesTable, StoryPiecesTable } from "./data/schema.js";
import { ApiError } from "./errors.js";
import { type Claimed, LEASE_S, MAX_ATTEMPTS, claim, hold } from "./claims.js";
import { ffmpeg, ffprobe, workDir } from "./ffmpeg.js";
import type { ApiBus } from "./indexer.js";
import { startClaimLoop } from "./jobs.js";
import { type KeyRing, encryptSegment, sealObject, segmentIV, segmentKey } from "./keys.js";
import { type Run, runBytes, runsOf, segmentDecrypter } from "./recordings.js";
import { wall } from "./local-time.js";
import { segmentsIn } from "./routes/playback.js";
import { type ObjectStorage, readObject } from "./storage.js";

/** Limits on one story: what a person watches in one sitting, and what one render may cost. */
export const STORY_LIMITS = {
  pieces: 20,
  /** Recorded video in the story (gap cards come on top). */
  totalMs: 10 * 60_000,
  pieceMs: 3 * 60_000,
  /** A gap longer than this between two pieces is said in the next piece's caption ("+5 min · Kitchen"). */
  gapNoteAfterMs: 60_000,
} as const;
/** An event's piece: a little before it, and a little after it ended. */
const EVENT_BEFORE_MS = 3000;
const EVENT_AFTER_MS = 5000;
/** Pieces on one camera closer than this are one piece. */
const MERGE_MS = 2000;
/** The weakest search match a story takes from a search (memory search scores, MiniLM cosine). */
const SEARCH_MIN_SCORE = 0.25;

export type StoryRow = Selectable<StoriesTable>;
export type PieceRow = Selectable<StoryPiecesTable>;

export interface MomentInput {
  event?: string;
  source?: string;
  from?: string;
  to?: string;
}
export interface StoryInput {
  title?: string;
  moments?: MomentInput[];
  search?: { q: string; from?: string; to?: string; sources?: string[]; limit?: number };
  mode?: "labelled" | "fast";
}

export interface StoryDeps {
  data: DataAccess;
  storage: ObjectStorage;
  keys: KeyRing;
  bus?: ApiBus;
}

export interface PlannedPiece {
  source_id: string;
  source_name: string;
  from: number;
  to: number;
  event_id: string | null;
  audio: boolean;
}

const time = (v: string | undefined, name: string): number => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  if (Number.isNaN(t)) throw new ApiError(400, "validation_failed", `${name} must be an RFC 3339 time`);
  return t;
};

/** The pieces a story's moments make, in time order, checked against the caller's grants. */
export async function planStory(deps: Pick<StoryDeps, "data" | "bus">, req: FastifyRequest, input: StoryInput): Promise<PlannedPiece[]> {
  const accountId = req.accountId!;
  const raw: { source_id: string; from: number; to: number; event_id: string | null }[] = [];
  const eventIds = new Set<string>();
  for (const [i, m] of (input.moments ?? []).entries()) {
    if (m.event) {
      eventIds.add(m.event);
      continue;
    }
    if (!m.source || !m.from || !m.to) throw new ApiError(400, "validation_failed", `moment ${i + 1}: give an event, or a source with from and to`);
    const from = time(m.from, `moments[${i}].from`);
    const to = time(m.to, `moments[${i}].to`);
    if (from >= to) throw new ApiError(400, "validation_failed", `moment ${i + 1}: from must be before to`);
    raw.push({ source_id: m.source, from, to, event_id: null });
  }
  const events = (rows: { id: string; source_id: string; occurred_at: Date; ended_at: Date | null }[]) => {
    for (const e of rows) {
      const at = new Date(e.occurred_at).getTime();
      const end = e.ended_at ? new Date(e.ended_at).getTime() : at;
      raw.push({ source_id: e.source_id, from: at - EVENT_BEFORE_MS, to: end + EVENT_AFTER_MS, event_id: e.id });
    }
  };
  if (eventIds.size) {
    const rows = await deps.data.withAccount(accountId, (s) => {
      let q = s.db.selectFrom("events").select(["id", "source_id", "occurred_at", "ended_at"]).where("id", "in", [...eventIds]);
      const granted = grantFilter<Database, "events">(req, "occurred_at");
      if (granted) q = q.where(granted);
      return q.execute();
    });
    const missing = [...eventIds].filter((id) => !rows.some((r) => r.id === id));
    if (missing.length) throw new ApiError(404, "not_found", `event not found: ${missing.slice(0, 3).join(", ")}`);
    events(rows);
  }
  if (input.search) {
    const q = input.search.q.trim();
    const to = input.search.to ? time(input.search.to, "search.to") : Date.now();
    const from = input.search.from ? time(input.search.from, "search.from") : to - 86_400_000;
    if (from >= to) throw new ApiError(400, "validation_failed", "search.from must be before search.to");
    const vec = (await deps.bus?.request<{ vectors: number[][] }>("rpc.brain.embed", { texts: [q] }, 10_000).catch(() => undefined))?.vectors?.[0];
    if (!vec) throw new ApiError(503, "service_unavailable", "search is unavailable: the brain did not answer");
    const v = `[${vec.join(",")}]`;
    const limit = Math.min(Math.max(input.search.limit ?? 10, 1), STORY_LIMITS.pieces);
    const rows = await deps.data.withAccount(accountId, (s) => {
      let query = s.db.selectFrom("events").select(["id", "source_id", "occurred_at", "ended_at"])
        .where("embedding", "is not", null).where("occurred_at", ">=", new Date(from)).where("occurred_at", "<", new Date(to))
        .where(sql<boolean>`1 - (embedding <=> ${v}::vector) >= ${SEARCH_MIN_SCORE}`);
      if (input.search!.sources?.length) query = query.where("source_id", "in", input.search!.sources);
      const granted = grantFilter<Database, "events">(req, "occurred_at");
      if (granted) query = query.where(granted);
      return query.orderBy(sql`embedding <=> ${v}::vector`).limit(limit).execute();
    });
    if (!rows.length) throw new ApiError(404, "not_found", "the search found nothing to put in a story");
    events(rows);
  }
  if (!raw.length) throw new ApiError(400, "validation_failed", "give moments or a search");

  // In time order; pieces on one camera that overlap or nearly touch become one.
  raw.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: typeof raw = [];
  for (const p of raw) {
    const same = [...merged].reverse().find((m) => m.source_id === p.source_id);
    if (same && p.from <= same.to + MERGE_MS) same.to = Math.max(same.to, p.to);
    else merged.push({ ...p });
  }
  for (const p of merged) p.to = Math.min(p.to, p.from + STORY_LIMITS.pieceMs);
  if (merged.length > STORY_LIMITS.pieces) {
    throw new ApiError(400, "validation_failed", `a story has at most ${STORY_LIMITS.pieces} pieces; this one would have ${merged.length}`);
  }
  const total = merged.reduce((a, p) => a + (p.to - p.from), 0);
  if (total > STORY_LIMITS.totalMs) {
    throw new ApiError(400, "validation_failed", `a story shows at most ${STORY_LIMITS.totalMs / 60_000} minutes of video; this one would be ${Math.ceil(total / 60_000)}`);
  }

  const sources = new Map((await deps.data.withAccount(accountId, (s) => s.sources.list())).map((x) => [x.id, x]));
  return merged.map((p) => {
    const src = sources.get(p.source_id);
    if (!src) throw new ApiError(404, "not_found", `source not found: ${p.source_id}`);
    // Every camera in the story: a video grant covering its piece (history where it is older than the recent stretch).
    requireRange(req, p.source_id, "video", new Date(p.from), new Date(p.to));
    if (blurredOnly(req.access?.grants, p.source_id)) {
      throw new ApiError(403, "forbidden_sense", `this agent sees ${src.name} only blurred: stories are made from recordings, which aren't blurred`, { blurred_only: true, source_id: p.source_id });
    }
    const senses = sensesForRange(req.access?.grants, p.source_id, new Date(p.from), new Date(p.to));
    return { source_id: p.source_id, source_name: src.name, from: p.from, to: p.to, event_id: p.event_id, audio: senses === "all" || senses.has("audio") };
  });
}

/** Signals the story worker that a story is waiting, so it doesn't wait for its next tick. */
export const storyKick = new EventTarget();

export async function createStory(
  data: DataAccess, accountId: string, pieces: PlannedPiece[], o: { title: string | null; mode: "labelled" | "fast"; actor: string; agentId: string | null },
): Promise<{ story: StoryRow; pieces: PieceRow[] }> {
  const id = newId("sty");
  const out = await data.withAccount(accountId, async (s) => {
    const story = await s.db.insertInto("stories").values({
      id, account_id: accountId, title: o.title, mode: o.mode, created_by: o.actor, created_by_agent: o.agentId,
    }).returningAll().executeTakeFirstOrThrow();
    const rows = await s.db.insertInto("story_pieces").values(pieces.map((p, seq) => ({
      story_id: id, seq, account_id: accountId, source_id: p.source_id, source_name: p.source_name,
      from_at: new Date(p.from), to_at: new Date(p.to), event_id: p.event_id, audio: p.audio,
    }))).returningAll().execute();
    return { story, pieces: rows };
  });
  storyKick.dispatchEvent(new Event("kick"));
  return out;
}

export function toStory(row: StoryRow, pieces: PieceRow[], playback?: { url: string; expiresAt: Date }) {
  // The captions and parts sit beside the playlist, under the same signed token.
  const beside = (path: string) => (playback ? playback.url.replace(/index\.m3u8$/, path) : undefined);
  const ordered = [...pieces].sort((a, b) => a.seq - b.seq);
  return {
    id: row.id,
    ...(row.title ? { title: row.title } : {}),
    mode: row.mode,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    pieces: ordered.map((p, i) => {
      const prev = ordered[i - 1];
      const gap = prev ? new Date(p.from_at).getTime() - new Date(prev.to_at).getTime() : 0;
      return {
        source_id: p.source_id, source_name: p.source_name,
        from: new Date(p.from_at).toISOString(), to: new Date(p.to_at).toISOString(),
        ...(p.event_id ? { event_id: p.event_id } : {}),
        audio: p.audio,
        ...(p.recorded_ms !== null ? { recorded_ms: p.recorded_ms } : {}),
        ...(p.offset_ms !== null ? { offset_ms: p.offset_ms } : {}),
        ...(gap > STORY_LIMITS.gapNoteAfterMs ? { gap_before_ms: gap } : {}),
      };
    }),
    ...(row.duration_ms !== null ? { duration_ms: row.duration_ms } : {}),
    bytes: Number(row.bytes),
    has_audio: row.has_audio,
    ...(playback ? { playback_url: playback.url, playback_expires_at: playback.expiresAt.toISOString() } : {}),
    ...(playback && row.captions_key ? { captions_url: beside("captions.vtt") } : {}),
    ...(row.parts?.length ? {
      parts: row.parts.map((x, n) => ({ pieces: x.pieces, duration_ms: x.duration_ms, bytes: x.bytes, has_audio: x.has_audio, ...(playback ? { download_url: beside(`part/${n}.mp4`) } : {}) })),
    } : {}),
    ...(row.note ? { note: row.note } : {}),
    created_at: new Date(row.created_at).toISOString(),
    ...(row.ready_at ? { ready_at: new Date(row.ready_at).toISOString() } : {}),
  };
}

// --- making the video ---------------------------------------------------------------
//
// Nothing is re-encoded (ADR 0070): the image ships no H.264 encoder. Every piece is the recorded segments
// themselves (whole segments, so cuts fall on keyframes), decrypted and encrypted again under the story's key.
// The camera and time of each piece are captions: a WebVTT track the player shows, and, in each downloadable
// MP4, a mov_text subtitle track. Pieces whose video (or sound) can't be joined without re-encoding (another
// codec or picture size) go in separate MP4 parts; in the browser the story still plays as one.

/** "+45 s", "+3 min", "+2 h 10 min" for a gap between pieces. */
export function gapText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `+${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `+${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h >= 48) return `+${Math.round(h / 24)} days`;
  return rest ? `+${h} h ${rest} min` : `+${h} h`;
}

function clock(at: number, timeZone: string): string {
  const w = wall(at, timeZone);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.d} ${months[w.m - 1]} ${p(w.hh)}:${p(w.mm)}:${p(w.ss)}`;
}

const vttTime = (ms: number) => {
  const t = Math.max(0, Math.round(ms));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(t / 3600_000))}:${p(Math.floor(t / 60_000) % 60)}:${p(Math.floor(t / 1000) % 60)}.${p(t % 1000, 3)}`;
};

export interface Cue { from: number; to: number; text: string }

/** A WebVTT file of cues (times in ms from the start of what it captions). */
export function webVtt(cues: Cue[]): string {
  return ["WEBVTT", "", ...cues.flatMap((c, i) => [String(i + 1), `${vttTime(c.from)} --> ${vttTime(c.to)}`, c.text.replace(/-->/g, "→"), ""])].join("\n");
}

interface StoredSegment { seq: number; piece: number | null; key: string; init_key: string; start_at: Date; duration_ms: number; key_source: string; strip_audio: boolean; enc_version: number | null; enc_iv: Buffer | null }

export interface StoryPart { pieces: number[]; duration_ms: number; bytes: number; key: string; has_audio: boolean }

/** A failure that retrying won't fix. */
export class StoryError extends Error {}

/** What can be joined without re-encoding: the video codec and picture, and the sound if it is kept. */
async function joinKey(run: Run, first: Buffer, keepAudio: boolean, signal: AbortSignal): Promise<string> {
  async function* bytes() {
    yield run.init;
    yield first;
  }
  const out = await ffprobe(["-show_streams", "-of", "json", "-f", "mp4", "-i", "pipe:0"], { input: bytes(), timeoutMs: 60_000, signal });
  const streams = (JSON.parse(out.toString()).streams ?? []) as Record<string, unknown>[];
  const pick = (s: Record<string, unknown> | undefined, keys: string[]) => (s ? keys.map((k) => String(s[k] ?? "")).join("/") : "none");
  const v = streams.find((s) => s.codec_type === "video");
  const a = keepAudio ? streams.find((s) => s.codec_type === "audio") : undefined;
  return `${pick(v, ["codec_name", "profile", "width", "height", "pix_fmt"])}|${pick(a, ["codec_name", "sample_rate", "channels"])}`;
}

/**
 * Copies a story's segments under this attempt's own prefix, under the story's own key (ADR 0066), so its
 * links never hand out a camera's key, and each attempt's object keys (so IVs) are its own. A labelled story
 * also gets its captions and its MP4 parts.
 */
async function buildStory(deps: StoryDeps, story: StoryRow, pieces: PieceRow[], prefix: string, signal: AbortSignal, log: FastifyBaseLogger | undefined) {
  const accountId = story.account_id;
  const segments: StoredSegment[] = [];
  const recorded = new Map<number, { recorded_ms: number; offset_ms: number }>();
  const created = new Date(story.created_at).getTime();
  const dk = await deps.keys.current(accountId);
  const storyKey = segmentKey(dk.key, story.id);
  const stop = () => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("stopped");
  };
  // Every piece's runs (whole recorded segments, one per recorder session) and their first segment, decrypted.
  type PieceRuns = { p: PieceRow; runs: { run: Run; first: Buffer; seqs: number[] }[] };
  const all: PieceRuns[] = [];
  let offset = 0;
  let bytes = 0;
  let at = created;
  for (const p of pieces) {
    stop();
    const rows = await deps.data.withAccount(accountId, (s) => segmentsIn(s, p.source_id, new Date(p.from_at).getTime(), new Date(p.to_at).getTime()));
    const runs = await runsOf(deps, rows);
    const decrypt = segmentDecrypter(deps, accountId, p.source_id);
    const entry: PieceRuns = { p, runs: [] };
    const startOffset = offset;
    for (const [i, run] of runs.entries()) {
      const initKey = `${prefix}init-${p.seq}-${i}.mp4`;
      await deps.storage.put(initKey, run.init, "video/mp4");
      const seqs: number[] = [];
      let first: Buffer | undefined;
      for (const r of run.rows) {
        stop();
        const plain = await decrypt(r, await readObject(deps.storage, r.key));
        first ??= plain;
        const seq = segments.length;
        const key = `${prefix}${String(seq).padStart(5, "0")}.m4s`;
        const iv = segmentIV(dk.key, key);
        const sealed = encryptSegment(storyKey, iv, plain);
        await deps.storage.put(key, sealed, "video/iso.segment");
        // Contiguous on the story's own clock; a new init (another camera or session) is a discontinuity anyway.
        segments.push({ seq, piece: p.seq, key, init_key: initKey, start_at: new Date(at), duration_ms: r.duration_ms,
          key_source: story.id, strip_audio: !p.audio, enc_version: dk.version, enc_iv: iv });
        seqs.push(seq);
        at += r.duration_ms;
        offset += r.duration_ms;
        bytes += sealed.length;
      }
      if (first) entry.runs.push({ run, first, seqs });
    }
    recorded.set(p.seq, { recorded_ms: offset - startOffset, offset_ms: startOffset });
    all.push(entry);
  }
  if (!segments.length) throw new StoryError("nothing was recorded in any of the story's moments");
  const hasAudio = all.some((x) => x.p.audio && x.runs.some((r) => r.run.hasAudio));
  if (story.mode === "fast") return { segments, recorded, hasAudio, bytes, parts: [] as StoryPart[], captionsKey: null, note: null };

  // Captions: each piece's camera and when it starts; a long gap is said at the start of the next piece.
  const tz = (await deps.data.withAccount(accountId, (s) => s.account.get()))?.time_zone ?? "UTC";
  const cues: Cue[] = [];
  let prevEnd: number | undefined;
  for (const x of all) {
    if (!x.runs.length) continue;
    const r = recorded.get(x.p.seq)!;
    const start = x.runs[0]!.run.rows[0] ? new Date(x.runs[0]!.run.rows[0].start_at).getTime() : new Date(x.p.from_at).getTime();
    const gap = prevEnd !== undefined && start - prevEnd > STORY_LIMITS.gapNoteAfterMs ? `${gapText(start - prevEnd)} · ` : "";
    cues.push({ from: r.offset_ms, to: r.offset_ms + r.recorded_ms, text: `${gap}${x.p.source_name} · ${clock(start, tz)}` });
    const last = x.runs.at(-1)!.run;
    prevEnd = last.end;
  }
  const captionsKey = `${prefix}captions.vtt`;
  await deps.storage.put(captionsKey, await sealObject(deps.keys, accountId, Buffer.from(webVtt(cues))), "text/vtt");

  // MP4 parts: runs that join without re-encoding, in story order; the sound only where the creator may hear it.
  type Unit = { piece: number; run: Run; seqs: number[]; audio: boolean; key: string };
  const units: Unit[] = [];
  for (const x of all) {
    for (const r of x.runs) {
      const audio = x.p.audio && r.run.hasAudio;
      units.push({ piece: x.p.seq, run: r.run, seqs: r.seqs, audio, key: await joinKey(r.run, r.first, audio, signal) });
    }
  }
  const groups: Unit[][] = [];
  for (const u of units) {
    const g = groups.at(-1);
    if (g && g[0]!.key === u.key) g.push(u);
    else groups.push([u]);
  }
  const dir = await mkdtemp(join(workDir(), "sp-story-"));
  const parts: StoryPart[] = [];
  try {
    for (const [n, g] of groups.entries()) {
      stop();
      const files: string[] = [];
      const partCues: Cue[] = [];
      let t = 0;
      for (const [i, u] of g.entries()) {
        const file = join(dir, `part-${n}-${i}.mp4`);
        // A remux, never an encode: the recorded packets as they are, timestamps from 0.
        await ffmpeg(["-y", "-f", "mp4", "-i", "pipe:0", "-map", "0:v:0", ...(u.audio ? ["-map", "0:a:0?"] : []), "-c", "copy", "-f", "mp4", file],
          { timeoutMs: 5 * 60_000, input: runBytes(deps, accountId, all.find((x) => x.p.seq === u.piece)!.p.source_id, u.run), signal });
        files.push(file);
        const dur = u.seqs.reduce((a, s) => a + segments[s]!.duration_ms, 0);
        const cue = cues.find((c) => c.from <= segments[u.seqs[0]!]!.start_at.getTime() - created && segments[u.seqs[0]!]!.start_at.getTime() - created < c.to);
        if (cue) partCues.push({ from: t, to: t + dur, text: cue.text });
        t += dur;
      }
      const list = join(dir, `part-${n}.txt`);
      await writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
      const vtt = join(dir, `part-${n}.vtt`);
      await writeFile(vtt, webVtt(partCues));
      const out = join(dir, `part-${n}.mp4`);
      await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-f", "webvtt", "-i", vtt, "-map", "0", "-map", "1:s", "-c", "copy", "-c:s", "mov_text",
        "-metadata:s:s:0", "language=eng", "-movflags", "+faststart", out], { timeoutMs: 10 * 60_000, signal });
      const key = `${prefix}part-${n}.mp4`;
      const sealed = await sealObject(deps.keys, accountId, await readFile(out));
      await deps.storage.put(key, sealed, "video/mp4");
      parts.push({ pieces: [...new Set(g.map((u) => u.piece))], duration_ms: t, bytes: sealed.length, key, has_audio: g.some((u) => u.audio) });
      for (const f of [...files, out]) await rm(f, { force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const note = parts.length > 1
    ? `The cameras in this story record differently (picture size, codec or sound), so without re-encoding it downloads as ${parts.length} MP4 parts; in the browser it plays as one.`
    : null;
  log?.info({ story: story.id, segments: segments.length, parts: parts.length }, "story made");
  return { segments, recorded, hasAudio, bytes, parts, captionsKey, note };
}

/** Claims one story for this caller (tests, tools); the worker uses claim() for due ones. */
async function claimStory(data: DataAccess, accountId: string, id: string): Promise<Claimed | undefined> {
  const token = randomUUID();
  const r = await data.withAccount(accountId, (s) => s.db.updateTable("stories")
    .set({ claim_token: token, claimed_until: new Date(Date.now() + LEASE_S * 1000), status: "rendering", attempts: sql<number>`attempts + 1` })
    .where("id", "=", id).where("due_at", "is not", null).where("attempts", "<", MAX_ATTEMPTS)
    .where((eb) => eb.or([eb("claimed_until", "is", null), eb("claimed_until", "<", new Date())])).executeTakeFirst());
  return Number(r.numUpdatedRows) ? { id, account_id: accountId, token } : undefined;
}

/**
 * Renders one claimed story and records the outcome, if the claim is still this one's. A failure is retried
 * (at most MAX_ATTEMPTS claims in all), then the story fails. Without a claim, claims the story first.
 */
export async function renderStory(deps: StoryDeps, accountId: string, storyId: string, log?: FastifyBaseLogger, claimed?: Claimed, o: { deadlineMs?: number } = {}): Promise<void> {
  const c = claimed ?? (await claimStory(deps.data, accountId, storyId));
  if (!c) return;
  const loaded = await deps.data.withAccount(accountId, async (s) => {
    const story = await s.db.selectFrom("stories").selectAll().where("id", "=", storyId).executeTakeFirst();
    const pieces = story ? await s.db.selectFrom("story_pieces").selectAll().where("story_id", "=", storyId).orderBy("seq").execute() : [];
    return story ? { story, pieces } : undefined;
  });
  if (!loaded || loaded.story.claim_token !== c.token) return;
  const { story, pieces } = loaded;
  const held = hold(deps.data, "stories", c, o);
  // This attempt's objects: its own prefix, so a slower attempt that lost its claim can never overwrite or delete the winner's.
  const prefix = `stories/${accountId}/${storyId}/${c.token.slice(0, 8)}/`;
  try {
    const out = await buildStory(deps, story, pieces, prefix, held.signal, log);
    if (!out.segments.length) throw new StoryError("nothing was recorded in any of the story's moments");
    const won = await deps.data.withAccount(accountId, async (s) => {
      const r = await s.db.updateTable("stories").set({
        status: "ready", error: null, duration_ms: out.segments.reduce((a, x) => a + x.duration_ms, 0),
        bytes: out.bytes + out.parts.reduce((a, x) => a + x.bytes, 0), has_audio: out.hasAudio,
        parts: JSON.stringify(out.parts), captions_key: out.captionsKey, note: out.note,
        ready_at: new Date(), due_at: null, claimed_until: null, claim_token: null,
      }).where("id", "=", storyId).where("claim_token", "=", c.token).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) return false;
      await s.db.deleteFrom("story_segments").where("story_id", "=", storyId).execute();
      for (let i = 0; i < out.segments.length; i += 500) {
        await s.db.insertInto("story_segments").values(out.segments.slice(i, i + 500).map((x) => ({ ...x, story_id: storyId, account_id: accountId }))).execute();
      }
      for (const [seq, rec] of out.recorded) {
        await s.db.updateTable("story_pieces").set(rec).where("story_id", "=", storyId).where("seq", "=", seq).execute();
      }
      return true;
    });
    if (!won) {
      // Taken over, or deleted, while it rendered: this attempt's objects go, nothing else.
      await deps.storage.deletePrefix(prefix);
      return;
    }
    await deleteOtherAttempts(deps.storage, accountId, storyId, prefix);
  } catch (err) {
    await deps.storage.deletePrefix(prefix).catch(() => undefined);
    const final = err instanceof StoryError || story.attempts >= MAX_ATTEMPTS;
    log?.warn({ err, story: storyId, attempts: story.attempts }, final ? "story failed" : "story render failed; will retry");
    await deps.data.withAccount(accountId, (s) => s.db.updateTable("stories").set(final
      ? { status: "failed", error: err instanceof StoryError ? err.message : "the story could not be made", due_at: null, claimed_until: null, claim_token: null }
      : { status: "queued", due_at: new Date(Date.now() + 30_000), claimed_until: null, claim_token: null })
      .where("id", "=", storyId).where("claim_token", "=", c.token).execute());
  } finally {
    held.release();
  }
}

/** Objects of earlier attempts that failed half way (their rows were never written). */
async function deleteOtherAttempts(storage: ObjectStorage, accountId: string, storyId: string, keep: string) {
  if (!storage.list) return;
  const stale: string[] = [];
  for await (const key of storage.list(`stories/${accountId}/${storyId}/`)) if (!key.startsWith(keep)) stale.push(key);
  if (stale.length) await storage.deleteMany(stale);
}

/** Claims stories waiting to be rendered, one at a time per process (rendering is the API's heaviest work). */
export function startStoryWorker(deps: StoryDeps, log: FastifyBaseLogger, intervalMs = 3000) {
  return startClaimLoop({
    name: "stories", intervalMs, log, kick: storyKick, batch: 1,
    claim: (max) => claim(deps.data, "stories", max),
    handle: (r) => renderStory(deps, r.account_id, r.id, log, r),
  });
}
