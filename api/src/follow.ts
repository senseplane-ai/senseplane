// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Following an object or a pet across cameras (ADR 0070): "how did this box
// move through the house?". Never a person: a description that names one is
// refused here, and a box on one by the brain (rpc.brain.follow_reference).
//
// A background job (ADR 0058) reads frames from each camera's recordings in
// the range (a frame a second around events, one every five seconds
// otherwise, within a frame budget), blacks out the camera's privacy masks in
// each (recordings are stored unmasked), sends them to a brain a camera at a
// time (rpc.brain.follow_scan), and links what it finds into a route: visits
// per camera in time order, handovers between cameras, and the gaps where it
// was not seen. Optionally it makes a story of the route.
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import jpeg from "jpeg-js";
import { type Selectable, sql } from "kysely";
import { type Access, type Grant, grantsForRoute, requireRange } from "./access.js";
import { blurredOnly } from "./blur.js";
import { type Claimed, MAX_ATTEMPTS, claim, hold } from "./claims.js";
import type { DataAccess } from "./data/access.js";
import { newId } from "./data/ids.js";
import type { FollowsTable } from "./data/schema.js";
import { ApiError } from "./errors.js";
import { ffmpeg, splitJpegs } from "./ffmpeg.js";
import type { ApiBus } from "./indexer.js";
import { startClaimLoop } from "./jobs.js";
import type { KeyRing } from "./keys.js";
import { rasterise } from "./masks.js";
import type { AuditLog } from "./module.js";
import { runBytes, runsOf } from "./recordings.js";
import { recordedRanges, segmentsIn } from "./routes/playback.js";
import { makeStory } from "./routes/stories.js";
import { STORY_LIMITS } from "./stories.js";
import { type ObjectStorage, readObject } from "./storage.js";

/** Limits on one follow: what it may read and how many vision model calls it may make. */
export const FOLLOW_LIMITS = {
  rangeMs: 2 * 3600_000,
  sources: 8,
  frames: 240,
  modelCalls: 12,
  /** Of those, at most this many go to finding a described thing. */
  describeCalls: 6,
  batch: 20,
} as const;
/** Around an event, a frame a second; elsewhere one every five seconds. */
const EVENT_STEP_MS = 1000;
const BASE_STEP_MS = 5000;
/** Sightings on one camera closer than this are one visit. */
const VISIT_GAP_MS = 30_000;
/** Time between visits longer than this is reported as a gap. */
const GAP_REPORT_MS = 15_000;
/** A sighting this much inside a privacy mask is dropped (nothing behind a mask is reported). */
const MASKED_DROP = 0.5;

export type FollowRow = Selectable<FollowsTable>;

export interface FollowDeps {
  data: DataAccess;
  storage: ObjectStorage;
  keys: KeyRing;
  bus?: ApiBus;
  audit?: AuditLog;
  /** Has the workspace used up its AI checks (a hard limit)? Then no batch may call the model. */
  checksUsedUp?: (accountId: string) => Promise<boolean>;
}

// --- the person guard --------------------------------------------------------------

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const PERSON_WORDS = words(`
  person persons people man men woman women boy boys girl girls child children kid kids kiddo baby babies toddler toddlers infant
  teen teens teenager teenagers youth youngster adult adults lad lads lass lasses bloke blokes dude dudes fella fellas fellow guy guys gal gals chap chaps
  gent gents gentleman gentlemen lady ladies sir madam mister miss missus
  son sons daughter daughters husband wife wives partner spouse boyfriend girlfriend mum mom mummy mommy mother dad daddy father parent parents
  brother brothers sister sisters sibling grandma grandpa granny gran grandad grandmother grandfather grandson granddaughter grandchild
  uncle aunt auntie nephew niece cousin friend friends neighbour neighbours neighbor neighbors flatmate roommate housemate
  he she him her hers his they them their someone somebody anyone anybody everyone everybody whoever who one ones
  intruder burglar thief thieves robber robbers stranger strangers visitor visitors guest guests trespasser suspect
  courier couriers postman postwoman postie mailman mailwoman milkman binman binmen dustman driver drivers rider riders cyclist cyclists
  walker walkers runner runners jogger joggers pedestrian pedestrians
  nanny babysitter cleaner carer worker workers builder builders plumber electrician gardener handyman tradesman tradie engineer technician
  employee employees customer customers client staff colleague boss manager student pupil resident tenant landlord landlady owner owners
  officer police policeman policewoman cop guard security human humans individual figure face faces head body somebody's
`);
/** Person words in other languages: a description that isn't English gets these, and the model's check besides. */
const PERSON_WORDS_OTHER = words(`
  hombre hombres mujer mujeres niño niña niños niñas chico chica señor señora persona personas ladrón
  mann männer frau frauen junge mädchen kind kinder person personen dieb
  homme hommes femme femmes garçon fille enfant enfants personne voleur
  uomo uomini donna donne ragazzo ragazza bambino bambina persona ladro
  homem mulher menino menina criança pessoa
  vrouw jongen meisje persoon
`);
/** Words ending in -man/-men/-woman/-person that aren't people. */
const NOT_PEOPLE = words("ottoman ottomans doberman dobermans talisman caiman pac-man german roman");
/** Where the head of a description ends: what follows describes it ("in the red jacket", "with red tape", "that the courier left"). */
const BREAK_WORDS = words("with in on at near by from under over beside behind next of that which whose carrying holding wearing pushing pulling left took took dropped de del von mit avec con dans");
const DETERMINERS = words("the a an my our your this that these those his her their its el la los las der die das den dem ein eine le les un une il lo gli");

const PRONOUNS = words("her his their him them");
const personish = (w: string) => PERSON_WORDS.has(w) || PERSON_WORDS_OTHER.has(w) || (!NOT_PEOPLE.has(w) && /(man|men|woman|women|person|people)$/.test(w) && w.length > 4);

/**
 * Does a description name a person? The head of the description is read (up to the first word that starts
 * what describes it, or a second determiner starting a clause: "the box the courier left"); any person word
 * in it refuses it, wherever it is ("the cat lady", "the parcel thief", "the one in the red jacket"). A
 * person's thing ("my son's backpack", "the dog's ball") is not a person.
 */
export function namesAPerson(description: string): boolean {
  const tokens = description.toLowerCase().normalize("NFC").replace(/[’`]/g, "'").match(/[\p{L}'-]+/gu) ?? [];
  let content = 0;
  for (const [i, raw] of tokens.entries()) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (!w) continue;
    if (content > 0 && (BREAK_WORDS.has(w) || DETERMINERS.has(w))) break;
    if (w.endsWith("'s") || w.endsWith("s'")) continue; // a possessor: whose thing it is
    // "her" alone is a person; "her bag" is her thing.
    const next = tokens[i + 1];
    if (PRONOUNS.has(w) && (!next || BREAK_WORDS.has(next))) return true;
    if (DETERMINERS.has(w)) continue;
    if (personish(w.replace(/'/g, ""))) return true;
    content++;
  }
  // Anywhere: words that only ever mean a person doing something ("whoever took the parcel").
  return tokens.some((t) => ["whoever", "someone", "somebody", "anyone", "anybody"].includes(t));
}

export const PERSON_REFUSAL = "Senseplane doesn't follow people, only objects and pets: choose something that isn't a person";

// --- privacy masks ------------------------------------------------------------------

type Polygons = number[][][];

/** A JPEG with the camera's privacy masks blacked out at its own size (recordings and old snapshots are stored unmasked). */
export function maskFrame(input: Buffer, polygons: Polygons): Buffer {
  if (!polygons.length) return input;
  const img = jpeg.decode(input, { useTArray: true, maxMemoryUsageInMB: 64 });
  const mask = rasterise(polygons, img.width, img.height);
  if (!mask) return input;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    img.data[i * 4] = 0;
    img.data[i * 4 + 1] = 0;
    img.data[i * 4 + 2] = 0;
  }
  return Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data }, 85).data);
}

/** How much of a box (fractions of the frame) lies under the masks, sampled on a 20×20 grid. */
export function maskedShare(box: number[], polygons: Polygons): number {
  if (!polygons.length) return 0;
  const n = 20;
  const mask = rasterise(polygons, n * 10, n * 10)!;
  let hit = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = Math.min(n * 10 - 1, Math.floor((box[0]! + ((box[2]! - box[0]!) * (i + 0.5)) / n) * n * 10));
      const y = Math.min(n * 10 - 1, Math.floor((box[1]! + ((box[3]! - box[1]!) * (j + 0.5)) / n) * n * 10));
      if (mask[y * n * 10 + x]) hit++;
    }
  }
  return hit / (n * n);
}

const masksOf = async (data: DataAccess, accountId: string, sourceId: string): Promise<Polygons> =>
  ((await data.withAccount(accountId, (s) => s.sources.get(sourceId)))?.privacy_masks as Polygons | undefined) ?? [];

// --- creating one -------------------------------------------------------------------

export interface FollowInput {
  reference: { event?: string; source?: string; at?: string; box?: number[]; description?: string };
  from: string;
  to: string;
  sources?: string[];
  make_story?: boolean;
}

const time = (v: string | undefined, name: string): number => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  if (Number.isNaN(t)) throw new ApiError(400, "validation_failed", `${name} must be an RFC 3339 time`);
  return t;
};

/** The reference picture, masked: an event's snapshot, or the recorded frame of a camera at a time. Checked against `req`'s grants. */
async function referenceImage(deps: Pick<FollowDeps, "data" | "storage" | "keys">, accountId: string, ref: FollowInput["reference"], req: FastifyRequest) {
  let sourceId: string;
  let at: number;
  let raw: Buffer;
  if (ref.event) {
    const e = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("events").select(["id", "source_id", "occurred_at", "snapshot_key"]).where("id", "=", ref.event!).executeTakeFirst());
    if (!e) throw new ApiError(404, "not_found", "event not found");
    requireRange(req, e.source_id, "video", new Date(e.occurred_at), new Date(e.occurred_at));
    if (!e.snapshot_key) throw new ApiError(409, "conflict", "this event has no snapshot to point at");
    sourceId = e.source_id;
    at = new Date(e.occurred_at).getTime();
    raw = await readObject(deps.storage, e.snapshot_key);
  } else {
    if (!ref.source || !ref.at) throw new ApiError(400, "validation_failed", "reference: give an event, or a source and a time, with a box; or a description");
    at = time(ref.at, "reference.at");
    requireRange(req, ref.source, "video", new Date(at), new Date(at));
    sourceId = ref.source;
    const [frame] = await framesAt(deps, accountId, ref.source, [at], []);
    if (!frame) throw new ApiError(404, "not_found", "nothing was recorded on that camera at that time");
    raw = frame.jpeg;
  }
  if (blurredOnly(req.access?.grants, sourceId)) throw new ApiError(403, "forbidden_sense", "this agent sees that camera only blurred", { blurred_only: true });
  return { sourceId, at, jpeg: maskFrame(raw, await masksOf(deps.data, accountId, sourceId)) };
}

type WireReference = Record<string, unknown>;

/** Asks a brain for the reference; refuses a person. */
async function brainReference(bus: ApiBus, accountId: string, sourceId: string, jpg: Buffer, box: number[], checked: boolean): Promise<{ reference: WireReference; calls: number }> {
  const out = await bus.request<{ reference?: WireReference; model_calls?: number; error?: string }>("rpc.brain.follow_reference", {
    account_id: accountId, source_id: sourceId, jpeg_b64: jpg.toString("base64"), box, ...(checked ? { checked: true } : {}),
  }, 60_000).catch(() => ({ error: "timeout" }) as { error: string; reference?: undefined; model_calls?: undefined });
  if (out.error === "person") throw new ApiError(403, "forbidden", PERSON_REFUSAL, { person: true });
  if (out.error === "bad_box") throw new ApiError(400, "validation_failed", "reference.box must be [x1, y1, x2, y2] as fractions of the picture, around the thing to follow");
  if (out.error || !out.reference) throw new ApiError(503, "service_unavailable", "the brain could not look at the reference; try again");
  return { reference: out.reference, calls: out.model_calls ?? 0 };
}

/** Checks a follow request against the caller's grants and the person guard, and queues it. */
export async function createFollow(deps: FollowDeps, req: FastifyRequest, input: FollowInput): Promise<FollowRow> {
  const accountId = req.accountId!;
  const from = time(input.from, "from");
  const to = time(input.to, "to");
  if (from >= to) throw new ApiError(400, "validation_failed", "from must be before to");
  if (to - from > FOLLOW_LIMITS.rangeMs) throw new ApiError(400, "validation_failed", `a follow covers at most ${FOLLOW_LIMITS.rangeMs / 3600_000} hours`);
  const ref = input.reference ?? {};
  const description = ref.description?.trim();
  if (description && namesAPerson(description)) throw new ApiError(403, "forbidden", PERSON_REFUSAL, { person: true });
  if (!ref.box && !description) throw new ApiError(400, "validation_failed", "reference: draw a box around the thing to follow, or describe it");
  if (ref.box && (ref.box.length !== 4 || ref.box.some((v) => typeof v !== "number" || v < 0 || v > 1) || ref.box[0]! >= ref.box[2]! || ref.box[1]! >= ref.box[3]!)) {
    throw new ApiError(400, "validation_failed", "reference.box must be [x1, y1, x2, y2] as fractions of the picture");
  }
  if (!deps.bus) throw new ApiError(503, "service_unavailable", "following needs a brain, and none is connected");
  if (deps.bus.supports && !(await deps.bus.supports("follow").catch(() => false))) {
    throw new ApiError(503, "service_unavailable", "not every brain running can follow objects yet; upgrade the brains, then try again");
  }

  // The cameras: those named, else every camera the caller may watch over the whole range.
  const all = await deps.data.withAccount(accountId, (s) => s.sources.list());
  const cameras = all.filter((x) => x.type !== "sensor");
  const wanted = input.sources?.length ? input.sources : cameras.map((x) => x.id);
  const sources: string[] = [];
  for (const id of [...new Set(wanted)]) {
    const src = cameras.find((x) => x.id === id);
    if (!src) {
      if (input.sources?.length) throw new ApiError(404, "not_found", `camera not found: ${id}`);
      continue;
    }
    try {
      requireRange(req, id, "video", new Date(from), new Date(to));
    } catch (err) {
      if (input.sources?.length) throw err;
      continue;
    }
    if (blurredOnly(req.access?.grants, id)) {
      if (input.sources?.length) throw new ApiError(403, "forbidden_sense", `this agent sees ${src.name} only blurred: following reads recordings, which aren't blurred`, { blurred_only: true });
      continue;
    }
    sources.push(id);
  }
  if (!sources.length) throw new ApiError(403, "forbidden_sense", "this caller has no video grant covering that range on any camera");
  if (sources.length > FOLLOW_LIMITS.sources) throw new ApiError(400, "validation_failed", `a follow looks at most ${FOLLOW_LIMITS.sources} cameras; name them in sources`);

  // The reference is checked now, so a person is refused at once; the job looks at it again without the model.
  let stored: Record<string, unknown> = { ...(description ? { description } : {}) };
  let calls = 0;
  if (ref.box) {
    const img = await referenceImage(deps, accountId, ref, req);
    const out = await brainReference(deps.bus, accountId, img.sourceId, img.jpeg, ref.box, false);
    calls += out.calls;
    stored = { ...stored, source_id: img.sourceId, at: new Date(img.at).toISOString(), box: ref.box, ...(ref.event ? { event_id: ref.event } : {}),
      ...(typeof out.reference.label === "string" ? { label: out.reference.label } : {}) };
  }
  const row = await deps.data.withAccount(accountId, (s) => s.db.insertInto("follows").values({
    id: newId("fol"), account_id: accountId, reference: JSON.stringify(stored), source_ids: sources,
    from_at: new Date(from), to_at: new Date(to), make_story: input.make_story ?? true, model_calls: calls,
    created_by: req.access?.actor ?? "account", created_by_agent: req.access?.agentId ?? null,
  }).returningAll().executeTakeFirstOrThrow());
  followKick.dispatchEvent(new Event("kick"));
  await deps.audit?.write({
    accountId, actor: req.access?.actor ?? "account", action: "follow.created", target: row.id, status: 202,
    details: { sources, from: new Date(from).toISOString(), to: new Date(to).toISOString(), by: ref.box ? "box" : "description" },
  }).catch(() => undefined);
  return row;
}

export const followKick = new EventTarget();

// --- reading frames ------------------------------------------------------------------

/**
 * JPEG frames (at most 640 wide) of a camera's recordings at the given times, the nearest frame within 0.7 s of
 * each, with the camera's privacy masks blacked out. The recording is piped into ffmpeg and the frames piped
 * out: nothing decrypted is written to disk.
 */
export async function framesAt(deps: Pick<FollowDeps, "data" | "storage" | "keys">, accountId: string, sourceId: string, times: number[], polygons: Polygons, signal?: AbortSignal): Promise<{ t: number; jpeg: Buffer }[]> {
  if (!times.length) return [];
  const sorted = [...times].sort((a, b) => a - b);
  const rows = await deps.data.withAccount(accountId, (s) => segmentsIn(s, sourceId, sorted[0]! - 1, sorted.at(-1)! + 1));
  const needed = rows.filter((r) => {
    const start = new Date(r.start_at).getTime();
    return sorted.some((t) => t >= start && t < start + r.duration_ms);
  });
  if (!needed.length) return [];
  const frames: { t: number; jpeg: Buffer }[] = [];
  for (const run of await runsOf(deps, needed)) {
    const out = await ffmpeg(["-f", "mp4", "-i", "pipe:0", "-an", "-vf", "fps=1,scale='min(640,iw)':-2", "-q:v", "5", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"],
      { timeoutMs: 5 * 60_000, input: runBytes(deps, accountId, sourceId, run), ...(signal ? { signal } : {}) });
    splitJpegs(out).forEach((j, k) => frames.push({ t: run.start + k * 1000, jpeg: j }));
  }
  const picked = new Map<number, { t: number; jpeg: Buffer }>();
  for (const t of sorted) {
    let best: number | undefined;
    for (const [i, f] of frames.entries()) if (Math.abs(f.t - t) <= 700 && (best === undefined || Math.abs(f.t - t) < Math.abs(frames[best]!.t - t))) best = i;
    if (best !== undefined && !picked.has(best)) picked.set(best, { t, jpeg: maskFrame(frames[best]!.jpeg, polygons) });
  }
  return [...picked.values()].sort((a, b) => a.t - b.t);
}

/** Times to look at on one camera: a frame a second around its events, one every five seconds elsewhere, within `budget`. */
export function sampleTimes(recorded: { from: number; to: number }[], events: { from: number; to: number }[], budget: number): number[] {
  const inRecording = (t: number) => recorded.some((r) => t >= r.from && t < r.to);
  const dense: number[] = [];
  for (const e of events) for (let t = e.from; t <= e.to; t += EVENT_STEP_MS) if (inRecording(t)) dense.push(t);
  const base: number[] = [];
  for (const r of recorded) for (let t = r.from + 500; t < r.to; t += BASE_STEP_MS) base.push(t);
  const even = (xs: number[], n: number) => (xs.length <= n ? xs : Array.from({ length: n }, (_, i) => xs[Math.floor((i * xs.length) / n)]!));
  const uniq = (xs: number[]) => {
    const out: number[] = [];
    for (const t of [...xs].sort((a, b) => a - b)) if (!out.length || t - out.at(-1)! >= 500) out.push(t);
    return out;
  };
  const d = even(uniq(dense), budget);
  return uniq([...d, ...even(uniq(base).filter((t) => !d.some((x) => Math.abs(x - t) < 500)), Math.max(0, budget - d.length))]);
}

// --- linking sightings into a route ------------------------------------------------

export interface FoundSighting { source_id: string; t: number; box: number[]; confidence: number; confirmed: boolean | null }
export interface Visit { source_id: string; source_name: string; from: number; to: number; sightings: number; confidence: number; confirmed_by_model: boolean }

/** `compared`: the frames actually compared with the reference; frames read but not compared count as not checked. */
export function linkRoute(sightings: FoundSighting[], names: Map<string, string>, recorded: Map<string, { from: number; to: number }[]>, compared: { source_id: string; t: number }[]) {
  const visits: Visit[] = [];
  const bySource = new Map<string, FoundSighting[]>();
  for (const s of sightings) bySource.set(s.source_id, [...(bySource.get(s.source_id) ?? []), s]);
  for (const [sourceId, list] of bySource) {
    let cur: Visit | undefined;
    for (const s of list.sort((a, b) => a.t - b.t)) {
      if (cur && s.t - cur.to <= VISIT_GAP_MS) {
        cur.to = s.t;
        cur.sightings++;
        cur.confidence = Math.max(cur.confidence, s.confidence);
        cur.confirmed_by_model ||= s.confirmed === true;
        continue;
      }
      cur = { source_id: sourceId, source_name: names.get(sourceId) ?? sourceId, from: s.t, to: s.t, sightings: 1, confidence: s.confidence, confirmed_by_model: s.confirmed === true };
      visits.push(cur);
    }
  }
  visits.sort((a, b) => a.from - b.from || a.to - b.to);
  const handovers = [];
  const gaps = [];
  for (let i = 1; i < visits.length; i++) {
    const a = visits[i - 1]!;
    const b = visits[i]!;
    if (a.source_id !== b.source_id) handovers.push({ from_source: a.source_id, to_source: b.source_id, left_at: iso(a.to), seen_at: iso(b.from), gap_ms: Math.max(0, b.from - a.to) });
    if (b.from - a.to > GAP_REPORT_MS) gaps.push({ from: iso(a.to), to: iso(b.from), note: gapNote(a.to, b.from, names, recorded, compared) });
  }
  return { visits, handovers, gaps };
}

const iso = (t: number) => new Date(t).toISOString();
const hhmmss = (t: number) => new Date(t).toISOString().slice(11, 19);

/** Why it wasn't seen, honestly: no camera recording, nothing compared, or compared and not there. */
export function gapNote(from: number, to: number, names: Map<string, string>, recorded: Map<string, { from: number; to: number }[]>, compared: { source_id: string; t: number }[]) {
  const recording = [...recorded].filter(([, rs]) => rs.some((r) => r.from < to && r.to > from)).map(([id]) => names.get(id) ?? id);
  const looked = compared.filter((e) => e.t > from && e.t < to).length;
  const span = `${hhmmss(from)}–${hhmmss(to)} UTC`;
  if (!recording.length) return `${span}: not seen; no camera was recording then`;
  if (!looked) return `${span}: not checked; no frame from then was compared with it (the frame limit, or it hadn't been found yet)`;
  return `${span}: not seen on ${recording.join(", ")} (${looked} frames looked at); it was somewhere no camera covers, or out of sight`;
}

/** A story's pieces for a route: each visit with a little either side, shrunk so the whole fits a story's limits. */
export function routePieces(visits: Visit[]): { source: string; from: string; to: string }[] {
  const chosen = visits.slice(0, STORY_LIMITS.pieces);
  const wanted = chosen.map((v) => ({ source: v.source_id, from: v.from - 2000, to: Math.min(v.to + 3000, v.from - 2000 + 60_000) }));
  const total = wanted.reduce((a, p) => a + (p.to - p.from), 0);
  if (total > STORY_LIMITS.totalMs) {
    // Every piece gets at most an equal share, and keeps its start.
    const share = Math.floor(STORY_LIMITS.totalMs / wanted.length);
    for (const p of wanted) p.to = Math.min(p.to, p.from + share);
  }
  return wanted.map((p) => ({ source: p.source, from: iso(p.from), to: iso(p.to) }));
}

// --- the job ---------------------------------------------------------------------------

/** The follow's creator as it is now: an agent's current grants (narrowed like a history route), else full access. */
async function creatorAccess(data: DataAccess, row: FollowRow): Promise<Access> {
  if (!row.created_by_agent) return { actor: row.created_by };
  const grants = await data.withAccount(row.account_id, (s) => s.db.selectFrom("grants").select(["source_ids", "senses", "window_from", "window_to", "abilities", "blurred_only"])
    .where("agent_id", "=", row.created_by_agent!).execute()) as Grant[];
  return { actor: row.created_by, agentId: row.created_by_agent, grants: grantsForRoute("POST /v1/follows", grants) };
}

class FollowFailure extends Error {}

/** Claims one follow for this caller (tests, tools); the worker uses claim() for due ones. */
async function claimFollow(data: DataAccess, accountId: string, id: string): Promise<Claimed | undefined> {
  const token = crypto.randomUUID();
  const r = await data.withAccount(accountId, (s) => s.db.updateTable("follows")
    .set({ claim_token: token, claimed_until: new Date(Date.now() + 900_000), status: "running", attempts: sql<number>`attempts + 1` })
    .where("id", "=", id).where("due_at", "is not", null).where("attempts", "<", MAX_ATTEMPTS)
    .where((eb) => eb.or([eb("claimed_until", "is", null), eb("claimed_until", "<", new Date())])).executeTakeFirst());
  return Number(r.numUpdatedRows) ? { id, account_id: accountId, token } : undefined;
}

export async function runFollow(deps: FollowDeps, accountId: string, id: string, log?: FastifyBaseLogger, claimed?: Claimed): Promise<void> {
  const c = claimed ?? (await claimFollow(deps.data, accountId, id));
  if (!c) return;
  const row = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("follows").selectAll().where("id", "=", id).executeTakeFirst());
  if (!row || row.claim_token !== c.token) return;
  const held = hold(deps.data, "follows", c);
  try {
    const out = await follow(deps, row, c, held.signal, log);
    await deps.data.withAccount(accountId, (s) => s.db.updateTable("follows").set({
      status: "done", error: null, result: JSON.stringify(out.result), story_id: out.storyId, frames_examined: out.frames, model_calls: out.calls,
      finished_at: new Date(), due_at: null, claimed_until: null, claim_token: null,
    }).where("id", "=", id).where("claim_token", "=", c.token).execute());
  } catch (err) {
    const refused = err instanceof ApiError && (err.details as { person?: boolean } | undefined)?.person === true;
    const final = refused || err instanceof FollowFailure || err instanceof ApiError || row.attempts >= MAX_ATTEMPTS;
    log?.warn({ err, follow: id, attempts: row.attempts }, final ? "follow failed" : "follow failed; will retry");
    await deps.data.withAccount(accountId, (s) => s.db.updateTable("follows").set(final
      ? { status: refused ? "refused" : "failed", error: err instanceof ApiError || err instanceof FollowFailure ? err.message : "the follow could not run", due_at: null, claimed_until: null, claim_token: null, finished_at: new Date() }
      : { status: "queued", due_at: new Date(Date.now() + 30_000), claimed_until: null, claim_token: null }).where("id", "=", id).where("claim_token", "=", c.token).execute());
  } finally {
    held.release();
  }
}

type ScanReply = { sightings?: { t: string; box: number[]; confidence: number; confirmed: boolean | null }[]; frames_examined?: number; model_calls?: number; reference?: WireReference; error?: string };

async function follow(deps: FollowDeps, row: FollowRow, c: Claimed, signal: AbortSignal, log?: FastifyBaseLogger) {
  if (!deps.bus) throw new FollowFailure("no brain is connected");
  const bus = deps.bus;
  const accountId = row.account_id;
  const from = new Date(row.from_at).getTime();
  const to = new Date(row.to_at).getTime();
  const access = await creatorAccess(deps.data, row);
  const req = { accountId, access } as unknown as FastifyRequest;
  const ref = row.reference as { source_id?: string; at?: string; box?: number[]; description?: string; event_id?: string; label?: string };
  const sources = (await deps.data.withAccount(accountId, (s) => s.sources.list())).filter((x) => row.source_ids.includes(x.id));
  const names = new Map(sources.map((x) => [x.id, x.name]));
  // A grant taken away since: that camera is left out.
  const allowed = sources.filter((x) => {
    try {
      requireRange(req, x.id, "video", new Date(from), new Date(to));
      return !blurredOnly(access.grants, x.id);
    } catch {
      return false;
    }
  });
  if (!allowed.length) throw new FollowFailure("no camera in this follow may be watched any more");

  let calls = row.model_calls;
  /** The model-call budget left for a batch: none once the workspace's AI checks are used up. */
  const budget = async (cap: number = FOLLOW_LIMITS.modelCalls) => {
    if (calls >= cap) return 0;
    if (deps.checksUsedUp && (await deps.checksUsedUp(accountId).catch(() => false))) return 0;
    return cap - calls;
  };
  /** Kept after every batch, so a retry carries on with what is left. */
  const spent = async (n: number) => {
    if (!n) return;
    calls += n;
    await deps.data.withAccount(accountId, (s) => s.db.updateTable("follows").set({ model_calls: calls }).where("id", "=", row.id).where("claim_token", "=", c.token).execute());
  };
  const stop = () => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("stopped");
  };

  let reference: WireReference | undefined;
  if (ref.box && ref.source_id && ref.at) {
    // Looked at again with the creator's grants as they are now.
    const img = await referenceImage(deps, accountId, ref.event_id ? { event: ref.event_id } : { source: ref.source_id, at: ref.at }, req);
    reference = (await brainReference(bus, accountId, img.sourceId, img.jpeg, ref.box, true)).reference;
  }

  // What to look at: a frame budget shared between the cameras.
  const recorded = new Map<string, { from: number; to: number }[]>();
  const frames = new Map<string, { t: number; jpeg: Buffer }[]>();
  let frameLimit = false;
  const share = Math.max(10, Math.floor(FOLLOW_LIMITS.frames / allowed.length));
  for (const src of allowed) {
    const ranges = await deps.data.withAccount(accountId, (s) => recordedRanges(s, src.id, from, to));
    recorded.set(src.id, ranges.map((r) => ({ from: Math.max(from, r.from.getTime()), to: Math.min(to, r.to.getTime()) })));
    const evs = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("events").select(["occurred_at", "ended_at"])
      .where("source_id", "=", src.id).where("occurred_at", ">=", new Date(from - 60_000)).where("occurred_at", "<", new Date(to)).orderBy("occurred_at").limit(500).execute());
    const times = sampleTimes(recorded.get(src.id)!, evs.map((e) => ({
      from: new Date(e.occurred_at).getTime() - 2000, to: (e.ended_at ? new Date(e.ended_at).getTime() : new Date(e.occurred_at).getTime()) + 2000 })), share);
    if (times.length >= share) frameLimit = true;
    stop();
    frames.set(src.id, await framesAt(deps, accountId, src.id, times, await masksOf(deps.data, accountId, src.id), signal));
  }

  // Pass 1, for a description: find the thing first, within its own share of the budget.
  if (!reference && ref.description) {
    for (const src of allowed) {
      const list = frames.get(src.id)!;
      for (let j = 0; j < list.length && !reference; j += FOLLOW_LIMITS.batch) {
        stop();
        const b = await budget(row.model_calls + FOLLOW_LIMITS.describeCalls);
        if (!b) break;
        const out = await bus.request<ScanReply>("rpc.brain.follow_scan", {
          account_id: accountId, source_id: src.id, budget: b, description: ref.description, find_only: true, person_check: true,
          frames: list.slice(j, j + FOLLOW_LIMITS.batch).map((f) => ({ t: iso(f.t), jpeg_b64: f.jpeg.toString("base64") })),
        }, 120_000);
        if (out.error === "no_model") throw new FollowFailure("finding a thing from a description needs a vision model; draw a box around it instead");
        if (out.error) throw new Error(`brain: ${out.error}`);
        await spent(out.model_calls ?? 0);
        if (out.reference) reference = out.reference;
      }
      if (reference) break;
    }
  }

  // Pass 2: every frame compared with the reference.
  const sightings: FoundSighting[] = [];
  const compared: { source_id: string; t: number }[] = [];
  const polygons = new Map<string, Polygons>();
  for (const src of allowed) polygons.set(src.id, await masksOf(deps.data, accountId, src.id));
  if (reference) {
    for (const src of allowed) {
      const list = frames.get(src.id)!;
      for (let j = 0; j < list.length; j += FOLLOW_LIMITS.batch) {
        stop();
        const batch = list.slice(j, j + FOLLOW_LIMITS.batch);
        const out = await bus.request<ScanReply>("rpc.brain.follow_scan", {
          account_id: accountId, source_id: src.id, budget: await budget(), reference,
          frames: batch.map((f) => ({ t: iso(f.t), jpeg_b64: f.jpeg.toString("base64") })),
        }, 120_000);
        if (out.error) throw new Error(`brain: ${out.error}`);
        await spent(out.model_calls ?? 0);
        for (const f of batch) compared.push({ source_id: src.id, t: f.t });
        for (const s of out.sightings ?? []) {
          // Nothing behind a privacy mask is reported, whatever the brain says.
          if (maskedShare(s.box, polygons.get(src.id)!) >= MASKED_DROP) continue;
          sightings.push({ source_id: src.id, t: Date.parse(s.t), box: s.box, confidence: s.confidence, confirmed: s.confirmed });
        }
      }
    }
  }
  const examined = [...frames.values()].reduce((a, l) => a + l.length, 0);
  const { visits, handovers, gaps } = linkRoute(sightings, names, recorded, compared);
  log?.info({ follow: row.id, frames: examined, compared: compared.length, sightings: sightings.length, visits: visits.length, calls }, "follow done");

  let storyId: string | null = null;
  let storyNote: string | undefined;
  if (row.make_story && visits.length) {
    try {
      const story = await makeStory(deps, req, { title: `Route of ${ref.description ?? ref.label ?? "the object"}`.slice(0, 200), moments: routePieces(visits) });
      storyId = story.story.id;
    } catch (err) {
      storyNote = err instanceof ApiError ? err.message : "the story could not be made";
    }
  }
  const usedUp = deps.checksUsedUp ? await deps.checksUsedUp(accountId).catch(() => false) : false;
  const result = {
    reference: { ...ref },
    route: visits.map((v) => ({ ...v, from: iso(v.from), to: iso(v.to), confidence: Number(v.confidence.toFixed(3)) })),
    handovers,
    gaps,
    ...(visits.length ? { first_seen: iso(visits[0]!.from), last_seen: iso(Math.max(...visits.map((v) => v.to))) } : {}),
    ...(!reference ? { note: "the described thing wasn't found in the frames looked at, so nothing was compared" } : {}),
    sightings: sightings.sort((a, b) => a.t - b.t).slice(0, 300).map((s) => ({ source_id: s.source_id, at: iso(s.t), box: s.box, confidence: s.confidence, confirmed: s.confirmed })),
    cameras: allowed.map((x) => ({ source_id: x.id, source_name: x.name, frames_examined: compared.filter((e) => e.source_id === x.id).length })),
    limits: { frames: FOLLOW_LIMITS.frames, frames_examined: examined, frames_compared: compared.length, frame_limit_reached: frameLimit, model_calls: calls,
      model_calls_cap: FOLLOW_LIMITS.modelCalls, ...(usedUp ? { ai_checks_used_up: true } : {}) },
    ...(storyNote ? { story_note: storyNote } : {}),
  };
  return { result, storyId, frames: examined, calls };
}

/** Claims follows waiting to run, one at a time per process. */
export function startFollowWorker(deps: FollowDeps, log: FastifyBaseLogger, intervalMs = 3000) {
  return startClaimLoop({
    name: "follows", intervalMs, log, kick: followKick, batch: 1,
    claim: (max) => claim(deps.data, "follows", max),
    handle: (r) => runFollow(deps, r.account_id, r.id, log, r),
  });
}
