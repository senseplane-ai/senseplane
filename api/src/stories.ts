// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Multi-camera stories (ADR 0070). A story is many moments (events, time
// ranges on cameras, or what a search finds) put in time order and made into
// one video, each piece labelled with its camera and time and long gaps
// replaced by a short "+3 min" card. A background job (ADR 0058) renders it
// with ffmpeg into HLS under stories/{account}/{story}/, encrypted with a key
// of the story's own (ADR 0066), so it outlives the raw recordings like a
// saved clip. Fast mode copies the recorded segments untouched instead: no
// labels, no cards, no re-encoding.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { type Selectable, sql } from "kysely";
import { grantFilter, requireRange, sensesForRange } from "./access.js";
import { blurredOnly } from "./blur.js";
import { captionBar, gapCard, gapText } from "./caption.js";
import type { DataAccess } from "./data/access.js";
import { newId } from "./data/ids.js";
import type { Database, StoriesTable, StoryPiecesTable } from "./data/schema.js";
import { ApiError } from "./errors.js";
import { ffmpeg, h264Encoder } from "./ffmpeg.js";
import { audioTrackIds } from "./fmp4.js";
import type { ApiBus } from "./indexer.js";
import { startClaimLoop } from "./jobs.js";
import { type KeyRing, decryptSegment, encryptSegment, segmentIV, segmentKey } from "./keys.js";
import { wall } from "./local-time.js";
import { segmentsIn } from "./routes/playback.js";
import { type ObjectStorage, readObject } from "./storage.js";

/** Limits on one story: what a person watches in one sitting, and what one render may cost. */
export const STORY_LIMITS = {
  pieces: 20,
  /** Recorded video in the story (gap cards come on top). */
  totalMs: 10 * 60_000,
  pieceMs: 3 * 60_000,
  /** A gap longer than this between two pieces becomes a card. */
  gapCardAfterMs: 60_000,
  gapCardMs: 2000,
} as const;
/** An event's piece: a little before it, and a little after it ended. */
const EVENT_BEFORE_MS = 3000;
const EVENT_AFTER_MS = 5000;
/** Pieces on one camera closer than this are one piece. */
const MERGE_MS = 2000;
/** The weakest search match a story takes from a search (memory search scores, MiniLM cosine). */
const SEARCH_MIN_SCORE = 0.25;
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 25;
const LEASE_S = 900;
const MAX_ATTEMPTS = 3;

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
        ...(gap > STORY_LIMITS.gapCardAfterMs ? { gap_before_ms: gap } : {}),
      };
    }),
    ...(row.duration_ms !== null ? { duration_ms: row.duration_ms } : {}),
    bytes: Number(row.bytes),
    has_audio: row.has_audio,
    ...(playback ? { playback_url: playback.url, playback_expires_at: playback.expiresAt.toISOString() } : {}),
    created_at: new Date(row.created_at).toISOString(),
    ...(row.ready_at ? { ready_at: new Date(row.ready_at).toISOString() } : {}),
  };
}

// --- reading recordings ---------------------------------------------------------

/** A stretch of one recording session as a local fMP4 file (its init and decrypted segments). */
export interface LocalRun {
  file: string;
  start: number;
  end: number;
  hasAudio: boolean;
}

/**
 * Writes the recorded segments of [from, to) on a camera to local files, one per recorder session
 * (init segment), decrypted (ADR 0066). Used by story rendering and by object following.
 */
export async function recordingToFiles(deps: Pick<StoryDeps, "data" | "storage" | "keys">, accountId: string, sourceId: string, from: number, to: number, dir: string, name: string): Promise<LocalRun[]> {
  const rows = await deps.data.withAccount(accountId, (s) => segmentsIn(s, sourceId, from, to));
  const runs: { init: string; rows: typeof rows }[] = [];
  for (const r of rows) {
    const last = runs.at(-1);
    const prevEnd = last ? new Date(last.rows.at(-1)!.start_at).getTime() + last.rows.at(-1)!.duration_ms : 0;
    // A new session, or a gap in the recording, starts a new file (timestamps in one file must run on).
    if (last && last.init === r.init_key && new Date(r.start_at).getTime() - prevEnd < 1500) last.rows.push(r);
    else runs.push({ init: r.init_key, rows: [r] });
  }
  const keyCache = new Map<number, Buffer>();
  const keyFor = async (version: number) => {
    let k = keyCache.get(version);
    if (!k) {
      const dk = await deps.keys.get(accountId, version);
      if (!dk) throw new Error("this recording's key no longer exists");
      k = segmentKey(dk, sourceId);
      keyCache.set(version, k);
    }
    return k;
  };
  const out: LocalRun[] = [];
  for (const [i, run] of runs.entries()) {
    const init = await readObject(deps.storage, run.init);
    const parts: Buffer[] = [init];
    for (let j = 0; j < run.rows.length; j += 8) {
      const batch = await Promise.all(run.rows.slice(j, j + 8).map(async (r) => {
        const body = await readObject(deps.storage, r.key);
        return r.enc_version !== null && r.enc_iv ? decryptSegment(await keyFor(r.enc_version), r.enc_iv, body) : body;
      }));
      parts.push(...batch);
    }
    const file = join(dir, `${name}-${i}.mp4`);
    await writeFile(file, Buffer.concat(parts));
    const first = run.rows[0]!;
    const last = run.rows.at(-1)!;
    let hasAudio = false;
    try {
      hasAudio = audioTrackIds(init).size > 0;
    } catch {
      hasAudio = false;
    }
    out.push({ file, start: new Date(first.start_at).getTime(), end: new Date(last.start_at).getTime() + last.duration_ms, hasAudio });
  }
  return out;
}

// --- rendering ------------------------------------------------------------------

const s3 = (ms: number) => (ms / 1000).toFixed(3);

function clock(at: number, timeZone: string): string {
  const w = wall(at, timeZone);
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${w.d} ${months[w.m - 1]} ${p(w.hh)}:${p(w.mm)}:${p(w.ss)}`;
}

/** One rendered stretch: 1280×720, 25 fps, H.264, and AAC stereo when the story has sound. */
async function renderRun(run: LocalRun, from: number, to: number, label: string, timeText: string, withAudio: boolean, audio: boolean, dir: string, out: string) {
  const bar = captionBar(WIDTH, label, timeText);
  const barFile = `${out}.bar.rgba`;
  await writeFile(barFile, bar.data);
  const offset = Math.max(0, from - run.start);
  const dur = Math.min(to, run.end) - Math.max(from, run.start);
  const useAudio = withAudio && audio && run.hasAudio;
  const args = ["-y", "-ss", s3(offset), "-t", s3(dur), "-i", run.file, "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${WIDTH}x${bar.height}`, "-i", barFile];
  if (withAudio && !useAudio) args.push("-f", "lavfi", "-t", s3(dur), "-i", "anullsrc=r=48000:cl=stereo");
  const filter = [
    `[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS}[v]`,
    "[1:v]loop=loop=-1:size=1:start=0[bar]",
    "[v][bar]overlay=0:H-h:shortest=1,format=yuv420p[out]",
  ];
  if (useAudio) filter.push("[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]");
  args.push("-filter_complex", filter.join(";"), "-map", "[out]");
  if (withAudio) args.push("-map", useAudio ? "[a]" : "2:a", "-c:a", "aac", "-b:a", "96k");
  args.push(...(await h264Encoder()), "-pix_fmt", "yuv420p", "-r", String(FPS), "-t", s3(dur), out);
  await ffmpeg(args, 10 * 60_000);
  await rm(barFile, { force: true });
  return dur;
}

async function renderCard(big: string, small: string, withAudio: boolean, out: string) {
  const card = gapCard(WIDTH, HEIGHT, big, small);
  const file = `${out}.rgba`;
  await writeFile(file, card.data);
  const frames = Math.round((STORY_LIMITS.gapCardMs / 1000) * FPS);
  const args = ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${WIDTH}x${HEIGHT}`, "-framerate", String(FPS), "-i", file];
  if (withAudio) args.push("-f", "lavfi", "-t", s3(STORY_LIMITS.gapCardMs), "-i", "anullsrc=r=48000:cl=stereo");
  args.push("-filter_complex", `[0:v]loop=loop=${frames - 1}:size=1:start=0,setsar=1,format=yuv420p[out]`, "-map", "[out]");
  if (withAudio) args.push("-map", "1:a", "-c:a", "aac", "-b:a", "96k");
  args.push(...(await h264Encoder()), "-pix_fmt", "yuv420p", "-r", String(FPS), "-t", s3(STORY_LIMITS.gapCardMs), out);
  await ffmpeg(args, 60_000);
  await rm(file, { force: true });
}

interface StoredSegment { seq: number; piece: number | null; key: string; init_key: string; start_at: Date; duration_ms: number; key_source: string; strip_audio: boolean; enc_version: number | null; enc_iv: Buffer | null }

/** Renders (or, in fast mode, copies) a story's segments; returns what to record. */
async function buildStory(deps: StoryDeps, story: StoryRow, pieces: PieceRow[], log: FastifyBaseLogger | undefined) {
  const accountId = story.account_id;
  const prefix = `stories/${accountId}/${story.id}/`;
  // A previous attempt may have left objects behind.
  await deps.storage.deletePrefix(prefix);
  const segments: StoredSegment[] = [];
  const recorded = new Map<number, { recorded_ms: number; offset_ms: number }>();
  const created = new Date(story.created_at).getTime();

  if (story.mode === "fast") {
    let offset = 0;
    let bytes = 0;
    for (const p of pieces) {
      const rows = await deps.data.withAccount(accountId, (s) => segmentsIn(s, p.source_id, new Date(p.from_at).getTime(), new Date(p.to_at).getTime()));
      recorded.set(p.seq, { recorded_ms: rows.reduce((a, r) => a + r.duration_ms, 0), offset_ms: offset });
      const inits = new Map<string, string>();
      for (const r of rows) {
        if (!inits.has(r.init_key)) {
          const to = `${prefix}init-${p.seq}-${inits.size}.mp4`;
          await deps.storage.copy(r.init_key, to);
          inits.set(r.init_key, to);
        }
        const seq = segments.length;
        const key = `${prefix}${String(seq).padStart(5, "0")}.m4s`;
        await deps.storage.copy(r.key, key);
        // The same ciphertext as the recording: its camera's key and the same IV.
        segments.push({ seq, piece: p.seq, key, init_key: inits.get(r.init_key)!, start_at: new Date(r.start_at), duration_ms: r.duration_ms,
          key_source: p.source_id, strip_audio: !p.audio, enc_version: r.enc_version, enc_iv: r.enc_iv });
        offset += r.duration_ms;
        bytes += Number(r.bytes);
      }
    }
    return { segments, recorded, hasAudio: pieces.some((p) => p.audio), bytes };
  }

  const dir = await mkdtemp(join(tmpdir(), "sp-story-"));
  try {
    const tz = (await deps.data.withAccount(accountId, (s) => s.account.get()))?.time_zone ?? "UTC";
    // Fetch every piece first: whether the story has sound depends on all of them.
    const runs = new Map<number, LocalRun[]>();
    for (const p of pieces) runs.set(p.seq, await recordingToFiles(deps, accountId, p.source_id, new Date(p.from_at).getTime(), new Date(p.to_at).getTime(), dir, `p${p.seq}`));
    const withAudio = pieces.some((p) => p.audio && runs.get(p.seq)!.some((r) => r.hasAudio));
    const parts: string[] = [];
    let offset = 0;
    let prevEnd: number | undefined;
    for (const p of pieces) {
      const from = new Date(p.from_at).getTime();
      const to = new Date(p.to_at).getTime();
      const pieceRuns = runs.get(p.seq)!.filter((r) => Math.min(to, r.end) - Math.max(from, r.start) >= 200);
      if (!pieceRuns.length) {
        recorded.set(p.seq, { recorded_ms: 0, offset_ms: offset });
        continue;
      }
      const shownFrom = Math.max(from, pieceRuns[0]!.start);
      if (prevEnd !== undefined && shownFrom - prevEnd > STORY_LIMITS.gapCardAfterMs) {
        const out = join(dir, `card-${p.seq}.mp4`);
        await renderCard(gapText(shownFrom - prevEnd), `then ${p.source_name}`, withAudio, out);
        parts.push(out);
        offset += STORY_LIMITS.gapCardMs;
      }
      const startOffset = offset;
      let shown = 0;
      for (const [i, run] of pieceRuns.entries()) {
        const out = join(dir, `piece-${p.seq}-${i}.mp4`);
        const runFrom = Math.max(from, run.start);
        shown += await renderRun(run, from, to, p.source_name, clock(runFrom, tz), withAudio, p.audio, dir, out);
        parts.push(out);
      }
      offset += shown;
      recorded.set(p.seq, { recorded_ms: Math.round(shown), offset_ms: startOffset });
      prevEnd = Math.min(to, pieceRuns.at(-1)!.end);
    }
    if (!parts.length) throw new StoryError("nothing was recorded in any of the story's moments");

    const list = join(dir, "list.txt");
    await writeFile(list, parts.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
    const hls = join(dir, "hls");
    await mkdir(hls);
    // The parts share one format, so they join without encoding again; cut into ~4 s fMP4 segments like a recording.
    await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-f", "hls", "-hls_time", "4", "-hls_playlist_type", "vod",
      "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", join(hls, "seg_%04d.m4s"), "-hls_list_size", "0",
      join(hls, "index.m3u8")], 10 * 60_000);
    const playlist = await readFile(join(hls, "index.m3u8"), "utf8");
    const entries = [...playlist.matchAll(/#EXTINF:([\d.]+),\s*\n([^\n#]+)/g)].map((m) => ({ ms: Math.round(Number(m[1]) * 1000), file: m[2]!.trim() }));
    const initKey = `${prefix}init.mp4`;
    await deps.storage.put(initKey, await readFile(join(hls, "init.mp4")), "video/mp4");
    // Encrypted at rest like the recordings (ADR 0066): HLS AES-128, with a key of the story's own.
    const dk = await deps.keys.current(accountId);
    const key = segmentKey(dk.key, story.id);
    let at = created;
    let bytes = 0;
    for (const [seq, e] of entries.entries()) {
      const objectKey = `${prefix}${String(seq).padStart(5, "0")}.m4s`;
      const iv = segmentIV(dk.key, objectKey);
      const sealed = encryptSegment(key, iv, await readFile(join(hls, e.file)));
      await deps.storage.put(objectKey, sealed, "video/iso.segment");
      bytes += sealed.length;
      segments.push({ seq, piece: null, key: objectKey, init_key: initKey, start_at: new Date(at), duration_ms: e.ms, key_source: story.id, strip_audio: false, enc_version: dk.version, enc_iv: iv });
      at += e.ms;
    }
    log?.info({ story: story.id, parts: parts.length, segments: entries.length }, "story rendered");
    return { segments, recorded, hasAudio: withAudio, bytes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A failure that retrying won't fix. */
export class StoryError extends Error {}

/** Renders one claimed story and records the outcome; a failure is retried twice, then the story fails. */
export async function renderStory(deps: StoryDeps, accountId: string, storyId: string, log?: FastifyBaseLogger): Promise<void> {
  const loaded = await deps.data.withAccount(accountId, async (s) => {
    const story = await s.db.selectFrom("stories").selectAll().where("id", "=", storyId).executeTakeFirst();
    const pieces = story ? await s.db.selectFrom("story_pieces").selectAll().where("story_id", "=", storyId).orderBy("seq").execute() : [];
    return story ? { story, pieces } : undefined;
  });
  if (!loaded) return;
  const { story, pieces } = loaded;
  try {
    const out = await buildStory(deps, story, pieces, log);
    if (!out.segments.length) throw new StoryError("nothing was recorded in any of the story's moments");
    const bytes = out.bytes;
    await deps.data.withAccount(accountId, async (s) => {
      // Deleted while it rendered: leave nothing behind.
      if (!(await s.db.selectFrom("stories").select("id").where("id", "=", storyId).executeTakeFirst())) return;
      await s.db.deleteFrom("story_segments").where("story_id", "=", storyId).execute();
      for (let i = 0; i < out.segments.length; i += 500) {
        await s.db.insertInto("story_segments").values(out.segments.slice(i, i + 500).map((x) => ({ ...x, story_id: storyId, account_id: accountId }))).execute();
      }
      for (const [seq, r] of out.recorded) {
        await s.db.updateTable("story_pieces").set(r).where("story_id", "=", storyId).where("seq", "=", seq).execute();
      }
      await s.db.updateTable("stories").set({
        status: "ready", error: null, duration_ms: out.segments.reduce((a, x) => a + x.duration_ms, 0), bytes: bytes, has_audio: out.hasAudio,
        ready_at: new Date(), due_at: null, claimed_until: null,
      }).where("id", "=", storyId).execute();
    });
    if (!(await deps.data.withAccount(accountId, (s) => s.db.selectFrom("stories").select("id").where("id", "=", storyId).executeTakeFirst()))) {
      await deps.storage.deletePrefix(`stories/${accountId}/${storyId}/`);
    }
  } catch (err) {
    const final = err instanceof StoryError || story.attempts >= MAX_ATTEMPTS;
    log?.warn({ err, story: storyId, attempts: story.attempts }, final ? "story failed" : "story render failed; will retry");
    if (final) await deps.storage.deletePrefix(`stories/${accountId}/${storyId}/`).catch(() => undefined);
    await deps.data.withAccount(accountId, (s) => s.db.updateTable("stories").set(final
      ? { status: "failed", error: err instanceof StoryError ? err.message : "the story could not be made", due_at: null, claimed_until: null }
      : { status: "queued", due_at: new Date(Date.now() + 30_000), claimed_until: null }).where("id", "=", storyId).execute());
  }
}

/** Claims stories waiting to be rendered, one at a time per process (rendering is the API's heaviest work). */
export function startStoryWorker(deps: StoryDeps, log: FastifyBaseLogger, intervalMs = 3000) {
  return startClaimLoop({
    name: "stories", intervalMs, log, kick: storyKick, batch: 1,
    claim: async (max) => (await sql<{ id: string; account_id: string }>`select * from claim_stories(${max}, ${LEASE_S})`.execute(deps.data.db())).rows,
    handle: (r) => renderStory(deps, r.account_id, r.id, log),
  });
}
