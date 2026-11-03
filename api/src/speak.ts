// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Talk-back (ADR 0069): text to speech, played through a camera's speaker.
// An agent's or a watch's text goes to an OpenAI-compatible speech endpoint
// (POST {TTS_BASE_URL}/audio/speech, WAV out), gets a short chime in front of
// it, is kept sealed in storage (so a person can hear exactly what was said)
// and is played on the camera: a phone on the capture page through the media
// plane, which tells the page to fetch and play it, and a camera behind a box
// through a `speak` command the box must take within 10 s and play by its
// `run_by` deadline, or never. One speaker at a time per camera: a message
// is refused while a person is talking through the camera or another message
// is playing, and a person's push-to-talk cuts an agent's message off.
// 30 s per message, 6 messages a minute per camera, and every message,
// refused or said, is in the audit log with who, the camera, how long and
// the text.
import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { type Selectable, sql } from "kysely";
import { SPEAK, coversSense } from "./access.js";
import type { AccountScope, DataAccess, Source } from "./data/access.js";
import { newId } from "./data/ids.js";
import type { Destination, SpeakMessagesTable, SpeakStatus } from "./data/schema.js";
import type { ErrorCode } from "./errors.js";
import { startClaimLoop } from "./jobs.js";
import type { MediaControl } from "./media-driver.js";
import type { AuditLog } from "./module.js";
import type { PlaybackSigner } from "./playback.js";
import { bridgeKick } from "./bridge-kick.js";
import type { ObjectStorage } from "./storage.js";

/** The longest message, chime included. */
export const MAX_SPEAK_MS = 30_000;
/** Messages per camera per minute (agents and watches together). */
export const SPEAK_PER_MINUTE = 6;
/** A watch's message not said within this long is dropped: an old alert is worse than none. */
export const QUEUED_STALE_MS = 60_000;
/** Push-to-talk with no end from the media plane stops holding the speaker after this long. */
export const PERSON_MAX_MS = 10 * 60_000;
/** A box that hasn't taken a message by then never gets it, and it refuses one later than run_by (as for device commands, ADR 0067). */
export const TAKE_MS = 10_000;
const RUN_BY_GRACE_MS = 5_000;
/** How long the camera's link to fetch the clip lasts. */
const CLIP_LINK_S = 120;

export type SpeakRow = Selectable<SpeakMessagesTable>;

// --- audio -------------------------------------------------------------------

/** Mono 16-bit PCM. */
export interface Pcm {
  rate: number;
  samples: Int16Array;
}

export const durationMs = (p: Pcm) => Math.round((p.samples.length * 1000) / p.rate);

/** Reads a WAV file: 16-bit or 32-bit float PCM, any channels (mixed down to mono). */
export function parseWav(buf: Buffer): Pcm {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let fmt: { format: number; channels: number; rate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString("ascii", at, at + 4);
    let size = buf.readUInt32LE(at + 4);
    const start = at + 8;
    // A streamed WAV says 0 or 0xFFFFFFFF for its data size: the data is the rest of the file.
    if (id === "data" && (size === 0 || size === 0xffffffff || start + size > buf.length)) size = buf.length - start;
    if (id === "fmt ") {
      let format = buf.readUInt16LE(start);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(start + 24); // WAVE_FORMAT_EXTENSIBLE: the sub-format
      fmt = { format, channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    } else if (id === "data") {
      data = buf.subarray(start, start + size);
      break;
    }
    at = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("the WAV file has no format or no data");
  const { format, channels, rate, bits } = fmt;
  if (!channels || !rate) throw new Error("the WAV file has no channels or rate");
  const pcm16 = format === 1 && bits === 16;
  const float32 = format === 3 && bits === 32;
  if (!pcm16 && !float32) throw new Error(`unsupported WAV encoding (format ${format}, ${bits} bits); ask the speech service for 16-bit PCM`);
  const width = bits / 8;
  const frames = Math.floor(data.length / (width * channels));
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * width;
      sum += pcm16 ? data.readInt16LE(o) : Math.max(-1, Math.min(1, data.readFloatLE(o))) * 32767;
    }
    out[i] = Math.round(sum / channels);
  }
  return { rate, samples: out };
}

/** A mono 16-bit PCM WAV file. */
export function encodeWav(p: Pcm): Buffer {
  const bytes = p.samples.length * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + bytes, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(p.rate, 24);
  b.writeUInt32LE(p.rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(bytes, 40);
  for (let i = 0; i < p.samples.length; i++) b.writeInt16LE(p.samples[i]!, 44 + i * 2);
  return b;
}

/**
 * The chime before an agent speaks: two soft notes (B5 then G5), then a
 * pause, so a person hears that a machine is about to talk.
 */
export function chime(rate: number): Int16Array {
  const notes: [number, number][] = [[988, 0.16], [784, 0.26]];
  const pause = Math.round(rate * 0.2);
  const parts = notes.map(([hz, s]) => {
    const n = Math.round(rate * s);
    const a = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const attack = Math.min(1, t / 0.01);
      a[i] = Math.round(Math.sin(2 * Math.PI * hz * t) * attack * Math.exp(-t * 6) * 0.3 * 32767);
    }
    return a;
  });
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0) + pause);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The message as played: the chime, then the speech. */
export function withChime(speech: Pcm): Pcm {
  const c = chime(speech.rate);
  const out = new Int16Array(c.length + speech.samples.length);
  out.set(c, 0);
  out.set(speech.samples, c.length);
  return { rate: speech.rate, samples: out };
}

// --- text to speech ------------------------------------------------------------

/** An OpenAI-compatible speech endpoint (Kokoro behind an OpenAI-compatible server for self-hosting). */
export interface TtsConfig {
  /** TTS_BASE_URL, e.g. http://kokoro:8880/v1 */
  baseUrl: string;
  /** TTS_API_KEY, sent as a bearer when set. */
  apiKey?: string;
  /** TTS_MODEL (default kokoro). */
  model: string;
  /** TTS_VOICE: one plainly synthetic voice for the whole server (default af_heart). */
  voice: string;
  /** Tests answer here instead of the network. */
  fetch?: typeof fetch;
}

export function ttsConfigFromEnv(env = process.env): TtsConfig | undefined {
  const baseUrl = env.TTS_BASE_URL?.trim();
  if (!baseUrl) return undefined;
  return { baseUrl: baseUrl.replace(/\/$/, ""), ...(env.TTS_API_KEY ? { apiKey: env.TTS_API_KEY } : {}), model: env.TTS_MODEL || "kokoro", voice: env.TTS_VOICE || "af_heart" };
}

export class TtsError extends Error {}

/** Text to mono PCM through POST {baseUrl}/audio/speech. */
export async function synthesize(cfg: TtsConfig, text: string): Promise<Pcm> {
  let res: Response;
  try {
    res = await (cfg.fetch ?? fetch)(`${cfg.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input: text, response_format: "wav" }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new TtsError(`the speech service couldn't be reached (${(err as Error).message})`);
  }
  if (!res.ok) throw new TtsError(`the speech service answered ${res.status}`);
  try {
    return parseWav(Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    throw new TtsError(`the speech service's audio couldn't be read: ${(err as Error).message}`);
  }
}

// --- who speaks ------------------------------------------------------------------

export interface Speaker {
  kind: "user" | "account_key" | "agent" | "watch";
  actor: string;
  name: string | null;
  via: string;
  agentId?: string;
}

export const toSpeakMessage = (r: SpeakRow, clipUrl?: string | null) => ({
  id: r.id, source_id: r.source_id, kind: r.kind, text: r.text, status: r.status, message: r.message, duration_ms: r.duration_ms,
  requested_by: { kind: r.actor_kind, id: r.actor.replace(/^(user|owner|agent|watch):/, ""), name: r.actor_name },
  watch_id: r.watch_id, clip_url: clipUrl ?? null,
  created_at: new Date(r.created_at).toISOString(), finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
});

/** May this agent speak on this camera now (the speak grant, not implied by sensors, inside its window)? */
export async function agentMaySpeak(s: AccountScope, agentId: string, sourceId: string, at = new Date()): Promise<boolean> {
  const agent = await s.db.selectFrom("agents").select("revoked_at").where("id", "=", agentId).executeTakeFirst();
  if (!agent || agent.revoked_at) return false;
  const grants = await s.db.selectFrom("grants").select(["source_ids", "senses", "window_from", "window_to"]).where("agent_id", "=", agentId).execute();
  return grants.some((g) => g.source_ids.includes(sourceId) && coversSense(g.senses, SPEAK)
    && (!g.window_from || at >= new Date(g.window_from)) && (!g.window_to || at <= new Date(g.window_to)));
}

// --- saying it -----------------------------------------------------------------

export interface SpeakDeps {
  data: DataAccess;
  storage?: ObjectStorage;
  media?: MediaControl;
  audit?: AuditLog;
  tts?: TtsConfig;
  signer: PlaybackSigner;
  log?: FastifyBaseLogger;
  /** Shorter waits in tests. */
  takeMs?: number;
  waitMs?: number;
}

export interface SayOutcome {
  row: SpeakRow;
  /** The HTTP status for this outcome, and the error code when it isn't a success. */
  http: number;
  code?: ErrorCode;
}

/** Wakes this process's speech worker when a watch queued a message. */
export const speakKick = new EventTarget();

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clipKey = (accountId: string, sourceId: string, id: string) => `speak/${accountId}/${sourceId}/${id}.wav`;

/** The camera's own link to the clip: a path on this API, which the capture page and the box resolve against their API base. */
export const clipPath = (signer: PlaybackSigner, accountId: string, key: string, ttl = CLIP_LINK_S) =>
  `/media/${signer.sign({ kind: "object", accountId, key }, ttl).token}/speak.wav`;

/** Messages a phone stopped playing by now are played; nothing else moves on by itself. */
export async function settleSpeech(s: AccountScope) {
  await s.db.updateTable("speak_messages").set((eb) => ({ status: "played", finished_at: eb.ref("ends_at") }))
    .where("status", "=", "playing").where("kind", "!=", "person").where("ends_at", "<", new Date()).execute();
}

export function createSpeech(deps: SpeakDeps) {
  const { data } = deps;
  const takeMs = deps.takeMs ?? TAKE_MS;

  const audit = (accountId: string, r: SpeakRow, status: number, cameraName: string) => deps.audit?.write({
    accountId, actor: r.actor, action: `speak.${r.status}`, target: r.source_id, status,
    details: {
      message: r.id, camera: cameraName, kind: r.kind, by: r.actor_name, via: r.via, text: r.text, duration_ms: r.duration_ms, outcome: r.status,
      ...(r.watch_id ? { watch_id: r.watch_id } : {}), ...(r.message ? { why: r.message } : {}),
    },
  }).catch(() => undefined);

  const update = (accountId: string, id: string, set: Partial<Omit<SpeakRow, "id" | "account_id">>) =>
    data.withAccount(accountId, (s) => s.db.updateTable("speak_messages").set(set as never).where("id", "=", id).returningAll().executeTakeFirstOrThrow());

  /** Ends a message with an outcome and audits it. */
  const finish = async (accountId: string, id: string, status: SpeakStatus, message: string | null, http: number, code: ErrorCode | undefined, cameraName: string, extra: Partial<SpeakRow> = {}): Promise<SayOutcome> => {
    const done = status !== "playing" && status !== "sent";
    const row = await update(accountId, id, { status, message, ...(done ? { finished_at: new Date(), ends_at: null } : {}), ...extra });
    await audit(accountId, row, http, cameraName);
    return { row, http, ...(code ? { code } : {}) };
  };

  /** Is someone else using this camera's speaker now? */
  const busy = async (s: AccountScope, sourceId: string, except?: string) => {
    let q = s.db.selectFrom("speak_messages").select(["kind"]).where("source_id", "=", sourceId)
      .where("status", "in", ["playing", "sent"]).where("ends_at", ">", new Date());
    if (except) q = q.where("id", "!=", except);
    return q.executeTakeFirst();
  };

  /**
   * Says `text` on a camera for an agent, a person or a workspace key (from the route, after the grant check)
   * or a watch (from the queue, `existingId`). Every outcome is recorded and audited.
   */
  async function say(accountId: string, source: Source, who: Speaker, text: string, opts: { kind: "agent" | "watch"; watchId?: string; eventId?: string; existingId?: string }): Promise<SayOutcome> {
    const name = source.name;
    const base = {
      account_id: accountId, source_id: source.id, kind: opts.kind, actor: who.actor, actor_kind: who.kind, actor_name: who.name, via: who.via,
      agent_id: who.agentId ?? null, watch_id: opts.watchId ?? null, event_id: opts.eventId ?? null, text,
    } as const;
    let id = opts.existingId;
    const refuse = async (http: number, code: ErrorCode, message: string, status: SpeakStatus = "refused") => {
      if (!id) {
        id = newId("spk");
        await data.withAccount(accountId, (s) => s.db.insertInto("speak_messages").values({ id: id!, ...base, status: "refused", message }).execute());
      }
      return finish(accountId, id, status, message, http, code, name);
    };
    if (source.type === "sensor" || !source.speaker) {
      return refuse(409, "no_speaker", `${cap(name)} has no speaker. Speak works on phone cameras and on IP cameras whose box found two-way audio.`);
    }
    if (source.type !== "browser" && !(source.type === "rtsp" && source.bridge_id)) {
      return refuse(409, "no_speaker", `${cap(name)} can't play sound through Senseplane.`);
    }
    if (!deps.tts) return refuse(503, "service_unavailable", "Text to speech isn't set up on this server (TTS_BASE_URL).");
    if (!deps.storage) return refuse(503, "service_unavailable", "Speaking needs object storage, to keep what was said.");

    // The rate and the speaker are counted and taken under a lock on the camera, so two requests can't both slip in.
    const admitted = await data.withAccount(accountId, async (s) => {
      await s.db.selectFrom("sources").select("id").where("id", "=", source.id).forUpdate().executeTakeFirst();
      const recent = Number((await s.db.selectFrom("speak_messages").select((e) => e.fn.countAll().as("n")).where("source_id", "=", source.id)
        .where("kind", "!=", "person").where("status", "not in", ["refused", "queued"]).where("created_at", ">", new Date(Date.now() - 60_000))
        .executeTakeFirstOrThrow()).n);
      if (recent >= SPEAK_PER_MINUTE) return { error: [429, "rate_limited", `${cap(name)} has had ${SPEAK_PER_MINUTE} messages in the last minute, the most allowed. Try again shortly.`] as const };
      const other = await busy(s, source.id, id);
      if (other) {
        return { error: [409, "speaker_busy", other.kind === "person"
          ? `Someone is talking through ${name} right now. Try again when they've finished.`
          : `${cap(name)} is already playing a message. Try again when it has finished.`] as const };
      }
      // Holds the speaker while the speech is made.
      const hold = { status: "sent" as const, message: "Making the speech.", ends_at: new Date(Date.now() + 45_000) };
      if (id) await s.db.updateTable("speak_messages").set({ ...hold, claimed_until: null }).where("id", "=", id).execute();
      else {
        id = newId("spk");
        await s.db.insertInto("speak_messages").values({ id, ...base, ...hold }).execute();
      }
      return {};
    });
    if (admitted.error) {
      const [http, code, message] = admitted.error;
      return refuse(http, code, message);
    }

    let clip: Pcm;
    try {
      clip = withChime(await synthesize(deps.tts, text));
    } catch (err) {
      deps.log?.warn({ err, sourceId: source.id }, "text to speech failed");
      return finish(accountId, id!, "failed", `Nothing was said: ${(err as Error).message}.`, 503, "service_unavailable", name);
    }
    const ms = durationMs(clip);
    if (ms > MAX_SPEAK_MS) {
      return finish(accountId, id!, "refused", `That message would take ${Math.ceil(ms / 1000)} seconds; the most is ${MAX_SPEAK_MS / 1000}. Say less.`, 400, "message_too_long", name, { duration_ms: ms });
    }
    const wav = encodeWav(clip);
    const key = clipKey(accountId, source.id, id!);
    await deps.storage.put(key, wav, "audio/wav");
    await update(accountId, id!, { clip_key: key, clip_bytes: wav.length, duration_ms: ms });
    const url = clipPath(deps.signer, accountId, key);

    if (source.type === "browser") {
      // The capture page fetches and plays it; a person's push-to-talk stops it there.
      const delivered = await Promise.resolve(deps.media?.speak?.(source.id, { id: id!, url, durationMs: ms })).catch((err) => {
        deps.log?.warn({ err, sourceId: source.id }, "could not hand a message to the media plane");
        return false;
      });
      if (!delivered) return finish(accountId, id!, "offline", `${cap(name)} isn't connected right now, so nothing was said.`, 503, "camera_offline", name);
      return finish(accountId, id!, "playing", null, 200, undefined, name, { ends_at: new Date(Date.now() + ms + 1000) });
    }
    return sendToBox(accountId, source, id!, url, ms);
  }

  /** A camera behind a box: a `speak` command it takes within takeMs and plays by run_by, or never. */
  async function sendToBox(accountId: string, source: Source, id: string, url: string, ms: number): Promise<SayOutcome> {
    const name = source.name;
    const bcId = `bcm_${randomBytes(9).toString("base64url")}`;
    const expires = new Date(Date.now() + takeMs);
    await data.withAccount(accountId, async (s) => {
      await s.db.insertInto("bridge_commands").values({
        id: bcId, account_id: accountId, bridge_id: source.bridge_id!, kind: "speak", created_by: `speak:${id}`, expires_at: expires,
        // run_by: a box that gets this later (a slow network, a clock far off) refuses it rather than play it late (ADR 0067).
        args_sealed: data.box().encrypt(JSON.stringify({
          message_id: id, source_id: source.id, url, duration_ms: ms, run_by: new Date(expires.getTime() + RUN_BY_GRACE_MS).toISOString(),
        })),
      }).execute();
      await s.db.updateTable("speak_messages").set({ status: "sent", bridge_command_id: bcId, message: "Sent to the box.", ends_at: new Date(expires.getTime() + ms + 5000) })
        .where("id", "=", id).execute();
    });
    bridgeKick.dispatchEvent(new Event(source.bridge_id!));
    const until = Date.now() + (deps.waitMs ?? takeMs + ms + 5000);
    for (;;) {
      await new Promise((r) => setTimeout(r, 150));
      const now = await data.withAccount(accountId, (s) => s.db.selectFrom("speak_messages").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
      if (now.status !== "sent") return { row: now, http: now.status === "played" ? 200 : now.status === "late" || now.status === "offline" ? 503 : 502, ...(now.status === "played" ? {} : { code: now.status === "failed" ? "service_unavailable" as const : "camera_offline" as const }) };
      if (Date.now() >= expires.getTime()) {
        // Not taken in time: expire it, so the box can never play it later.
        const gone = await data.withAccount(accountId, (s) => s.db.updateTable("bridge_commands").set({ status: "expired", args_sealed: null, finished_at: new Date() })
          .where("id", "=", bcId).where("status", "=", "pending").executeTakeFirst());
        if (gone.numUpdatedRows) {
          return finish(accountId, id, "offline", `${cap(name)}'s box didn't take the message within ${Math.round(takeMs / 1000)} seconds, so it wasn't sent and won't play later. The box may be offline.`, 503, "camera_offline", name);
        }
      }
      if (Date.now() >= until) return { row: now, http: 202 };
    }
  }

  /** The box's report on a `speak` command (POST /v1/bridge/commands/{id}). */
  async function boxReported(accountId: string, bridgeCommandId: string, ok: boolean, error: string | undefined) {
    const row = await data.withAccount(accountId, (s) => s.db.selectFrom("speak_messages").selectAll().where("bridge_command_id", "=", bridgeCommandId).where("status", "=", "sent").executeTakeFirst());
    if (!row) return;
    const source = await data.withAccount(accountId, (s) => s.sources.get(row.source_id));
    const late = !ok && /too late/i.test(error ?? "");
    const status: SpeakStatus = ok ? "played" : late ? "late" : "failed";
    const message = ok ? null : late ? "It reached the box too late, so it wasn't played." : `The box couldn't play it: ${(error ?? "failed").slice(0, 300)}`;
    await finish(accountId, row.id, status, message, ok ? 200 : late ? 503 : 502, undefined, source?.name ?? row.source_id);
  }

  /**
   * Push-to-talk (the media plane's producer events for a viewer's `talkback` track): a person starts
   * talking, which cuts off any agent's message on that camera, or stops, which records how long.
   */
  async function personTalk(accountId: string, sourceId: string, sessionId: string, event: "start" | "end", at: Date) {
    const source = await data.withAccount(accountId, (s) => s.sources.get(sourceId));
    const name = source?.name ?? sourceId;
    if (event === "start") {
      const started = await data.withAccount(accountId, async (s) => {
        const already = await s.db.selectFrom("speak_messages").select("id").where("live_session_id", "=", sessionId).where("status", "=", "playing").executeTakeFirst();
        if (already) return undefined;
        const session = await s.db.selectFrom("live_sessions").select("actor").where("id", "=", sessionId).executeTakeFirst();
        const actor = session?.actor ?? "unknown";
        const user = actor.startsWith("user:")
          ? await s.db.selectFrom("users").select(["name", "email"]).where("id", "=", actor.slice(5)).executeTakeFirst()
          : undefined;
        const row = await s.db.insertInto("speak_messages").values({
          id: newId("spk"), account_id: accountId, source_id: sourceId, kind: "person", actor, actor_kind: actor.startsWith("user:") ? "user" : "account_key",
          actor_name: user?.name ?? user?.email ?? null, via: "live", live_session_id: sessionId, status: "playing",
          ends_at: new Date(at.getTime() + PERSON_MAX_MS), created_at: at,
        }).returningAll().executeTakeFirstOrThrow();
        const cut = await s.db.selectFrom("speak_messages").selectAll().where("source_id", "=", sourceId).where("kind", "!=", "person")
          .where("status", "in", ["playing", "sent"]).where("ends_at", ">", new Date()).execute();
        return { row, cut };
      });
      if (!started) return;
      for (const m of started.cut) {
        await Promise.resolve(deps.media?.stopSpeak?.(sourceId, m.id)).catch(() => undefined);
        await finish(accountId, m.id, "interrupted", "A person started talking through the camera, which cut this message off.", 200, undefined, name);
      }
      await audit(accountId, started.row, 200, name);
      return;
    }
    const open = await data.withAccount(accountId, (s) => s.db.selectFrom("speak_messages").selectAll().where("live_session_id", "=", sessionId).where("status", "=", "playing").executeTakeFirst());
    if (!open) return;
    const ms = Math.max(0, at.getTime() - new Date(open.created_at).getTime());
    await finish(accountId, open.id, "played", null, 200, undefined, name, { duration_ms: ms, finished_at: at });
  }

  /** Says the watch messages waiting in the queue (claimed across processes). Returns how many it handled. */
  const claim = async (max: number) => (await sql<{ id: string; account_id: string }>`select * from claim_speak_messages(${max}, ${120})`.execute(data.db())).rows;
  async function runQueued(max = 10): Promise<number> {
    const rows = await claim(max);
    for (const r of rows) await sayQueued(r.account_id, r.id).catch((err) => deps.log?.error({ err, id: r.id }, "a watch's message failed"));
    return rows.length;
  }

  async function sayQueued(accountId: string, id: string) {
    const row = await data.withAccount(accountId, (s) => s.db.selectFrom("speak_messages").selectAll().where("id", "=", id).where("status", "=", "queued").executeTakeFirst());
    if (!row) return;
    const source = await data.withAccount(accountId, (s) => s.sources.get(row.source_id));
    const name = source?.name ?? row.source_id;
    if (Date.now() - new Date(row.created_at).getTime() > QUEUED_STALE_MS) {
      return finish(accountId, id, "late", "The watch's message couldn't be said within a minute, so it was dropped.", 503, undefined, name);
    }
    if (!source) return finish(accountId, id, "refused", "The camera no longer exists.", 404, undefined, name);
    // The watch speaks as whoever made it: an agent needs a speak grant on the camera now, as when it set the watch.
    if (row.agent_id && !(await data.withAccount(accountId, (s) => agentMaySpeak(s, row.agent_id!, source.id)))) {
      return finish(accountId, id, "refused", `The agent that made this watch has no Speak permission for ${name}, so nothing was said.`, 403, undefined, name);
    }
    await say(accountId, source, { kind: "watch", actor: row.actor, name: row.actor_name, via: "watch", ...(row.agent_id ? { agentId: row.agent_id } : {}) }, row.text ?? "", {
      kind: "watch", existingId: id, ...(row.watch_id ? { watchId: row.watch_id } : {}), ...(row.event_id ? { eventId: row.event_id } : {}),
    });
  }

  return { say, boxReported, personTalk, runQueued, claim, sayQueued };
}

export type Speech = ReturnType<typeof createSpeech>;

/** A watch fired: its speak actions are queued, said by the speech worker (ADR 0069). */
export async function queueWatchSpeech(s: AccountScope, ev: { id: string; watch_id: string | null }, dests: Destination[]) {
  if (!ev.watch_id || !dests.length) return;
  const watch = await s.db.selectFrom("watches").select(["id", "instruction", "created_by_agent"]).where("id", "=", ev.watch_id).executeTakeFirst();
  if (!watch) return;
  const rows = dests.filter((d) => d.text).map((d) => {
    // Said as whoever added the action: the agent that added it (its grant is checked again when said),
    // else the agent that made the watch (actions saved before this was recorded), else the watch.
    const agent = d.added_by_agent ?? watch.created_by_agent ?? null;
    return {
      id: newId("spk"), account_id: s.accountId, source_id: d.id, kind: "watch" as const, actor: agent ? `agent:${agent}` : `watch:${watch.id}`,
      actor_kind: agent ? "agent" : "watch", actor_name: `Watch: ${watch.instruction.slice(0, 80)}`, via: "watch",
      agent_id: agent, watch_id: watch.id, event_id: ev.id, text: d.text!, status: "queued" as const,
    };
  });
  if (!rows.length) return;
  await s.db.insertInto("speak_messages").values(rows).execute();
  setTimeout(() => speakKick.dispatchEvent(new Event("kick")), 20);
}

/** The speech worker: watch messages, claimed like deliveries (ADR 0058). */
export function startSpeechWorker(speech: Speech, log: FastifyBaseLogger, intervalMs = 2000) {
  return startClaimLoop({
    name: "speech", intervalMs, log, kick: speakKick, batch: 5,
    claim: (max) => speech.claim(max),
    handle: async (r) => {
      await speech.sayQueued(r.account_id, r.id);
    },
  });
}

/**
 * Clips of what agents and watches said, past retention (recorded agent audio is personal data, ADR 0069):
 * the camera's retention days, the account's for a camera kept by size, else 7 days; at once for a camera
 * that no longer exists. Returns how many clips it deleted.
 */
export async function sweepSpeechClips(data: DataAccess, storage: ObjectStorage): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = (await sql<{ id: string; account_id: string; clip_key: string }>`select * from speak_clips_due(${500})`.execute(data.db())).rows;
    if (!rows.length) return deleted;
    await storage.deleteMany(rows.map((r) => r.clip_key));
    const byAccount = new Map<string, string[]>();
    for (const r of rows) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r.id]);
    for (const [accountId, ids] of byAccount) {
      await data.withAccount(accountId, (s) => s.db.updateTable("speak_messages").set({ clip_key: null, clip_bytes: null }).where("id", "in", ids).execute());
    }
    deleted += rows.length;
    if (rows.length < 500) return deleted;
  }
}
