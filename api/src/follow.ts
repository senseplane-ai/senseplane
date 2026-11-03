// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Following an object or a pet across cameras (ADR 0070): "how did this box
// move through the house?". Never a person: a description that names one is
// refused here, and a box on one by the brain (rpc.brain.follow_reference).
//
// A background job (ADR 0058) reads frames from each camera's recordings in
// the range (a frame a second around events, one every five seconds
// otherwise, within a frame budget), sends them to a brain a camera at a time
// (rpc.brain.follow_scan), and links what it finds into a route: visits per
// camera in time order, handovers between cameras, and the gaps where it was
// not seen. Optionally it makes a story of the route.
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { type Selectable, sql } from "kysely";
import { type Access, type Grant, grantsForRoute, requireRange } from "./access.js";
import { blurredOnly } from "./blur.js";
import type { DataAccess } from "./data/access.js";
import { newId } from "./data/ids.js";
import type { FollowsTable } from "./data/schema.js";
import { ApiError } from "./errors.js";
import { ffmpeg } from "./ffmpeg.js";
import type { ApiBus } from "./indexer.js";
import { startClaimLoop } from "./jobs.js";
import type { KeyRing } from "./keys.js";
import type { AuditLog } from "./module.js";
import { recordedRanges, segmentsIn } from "./routes/playback.js";
import { makeStory } from "./routes/stories.js";
import { segmentsToFiles } from "./stories.js";
import { type ObjectStorage, readObject } from "./storage.js";

/** Limits on one follow: what it may read and how many vision model calls it may make. */
export const FOLLOW_LIMITS = {
  rangeMs: 2 * 3600_000,
  sources: 8,
  frames: 240,
  modelCalls: 12,
  batch: 20,
} as const;
/** Around an event, a frame a second; elsewhere one every five seconds. */
const EVENT_STEP_MS = 1000;
const BASE_STEP_MS = 5000;
/** Sightings on one camera closer than this are one visit. */
const VISIT_GAP_MS = 30_000;
/** Time between visits longer than this is reported as a gap. */
const GAP_REPORT_MS = 15_000;
const LEASE_S = 900;
const MAX_ATTEMPTS = 3;

export type FollowRow = Selectable<FollowsTable>;

export interface FollowDeps {
  data: DataAccess;
  storage: ObjectStorage;
  keys: KeyRing;
  bus?: ApiBus;
  audit?: AuditLog;
}

// --- the person guard --------------------------------------------------------------

const PERSON_WORDS = new Set(("person people persons man men woman women boy boys girl girls child children kid kids baby babies toddler toddlers "
  + "teen teens teenager teenagers son sons daughter daughters husband wife wives partner boyfriend girlfriend mum mom mother dad father parent parents "
  + "brother sister sibling grandma grandpa granny grandmother grandfather grandson granddaughter uncle aunt auntie nephew niece cousin friend "
  + "neighbour neighbor guy guys lady ladies gentleman gentlemen he she him her them someone somebody anyone anybody everyone intruder burglar "
  + "thief robber courier postman postwoman mailman driver visitor guest stranger nanny babysitter cleaner worker builder plumber electrician "
  + "employee customer staff colleague boss student pupil resident tenant landlord officer policeman policewoman human humans individual figure "
  + "pedestrian cyclist rider runner jogger face faces head body owner").split(" "));
/** Things people follow: a person word after one of these is about the object ("the box the courier left"). */
const OBJECT_WORDS = new Set(("box boxes parcel parcels package packages crate carton bag bags suitcase luggage backpack rucksack handbag purse "
  + "cat cats kitten dog dogs puppy pet pets rabbit bunny hamster guinea bird parrot budgie tortoise turtle ferret horse chicken "
  + "toy toys ball bottle cup mug bin trolley cart bike bicycle scooter pram stroller buggy umbrella keys phone laptop tablet chair plant "
  + "vase book laundry basket tray shoe shoes coat jacket hat drone robot hoover vacuum mower ladder tool tools").split(" "));
/** Where the head of a description ends: what follows describes it ("in the red jacket", "with red tape"). */
const BREAK_WORDS = new Set("with in on at near by from under over beside behind next that which who whose carrying holding wearing pushing pulling".split(" "));

/** Does a description name a person ("the man in the red jacket", "my son")? A person's thing ("my son's bag") doesn't. */
export function namesAPerson(description: string): boolean {
  const tokens = description.toLowerCase().replace(/[’`]/g, "'").match(/[a-z']+/g) ?? [];
  for (const raw of tokens) {
    if (raw.endsWith("'s") || raw.endsWith("s'")) continue; // a possessor: whose thing it is
    const w = raw.replace(/'/g, "");
    if (OBJECT_WORDS.has(w)) return false;
    if (PERSON_WORDS.has(w)) return true;
    if (BREAK_WORDS.has(w)) return false;
  }
  return false;
}

export const PERSON_REFUSAL = "Senseplane doesn't follow people, only objects and pets: choose something that isn't a person";

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

/** The reference picture: an event's snapshot, or the recorded frame of a camera at a time. */
async function referenceImage(deps: Pick<FollowDeps, "data" | "storage" | "keys">, accountId: string, ref: FollowInput["reference"], req?: FastifyRequest) {
  if (ref.event) {
    const e = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("events").select(["id", "source_id", "occurred_at", "snapshot_key"]).where("id", "=", ref.event!).executeTakeFirst());
    if (!e) throw new ApiError(404, "not_found", "event not found");
    if (req) requireRange(req, e.source_id, "video", new Date(e.occurred_at), new Date(e.occurred_at));
    if (!e.snapshot_key) throw new ApiError(409, "conflict", "this event has no snapshot to point at");
    return { sourceId: e.source_id, at: new Date(e.occurred_at).getTime(), jpeg: await readObject(deps.storage, e.snapshot_key) };
  }
  if (!ref.source || !ref.at) throw new ApiError(400, "validation_failed", "reference: give an event, or a source and a time, with a box; or a description");
  const at = time(ref.at, "reference.at");
  if (req) requireRange(req, ref.source, "video", new Date(at), new Date(at));
  const [frame] = await framesAt(deps, accountId, ref.source, [at]);
  if (!frame) throw new ApiError(404, "not_found", "nothing was recorded on that camera at that time");
  return { sourceId: ref.source, at, jpeg: frame.jpeg };
}

type WireReference = Record<string, unknown>;

/** Asks a brain for the reference; refuses a person. */
async function brainReference(bus: ApiBus, accountId: string, sourceId: string, jpeg: Buffer, box: number[], checked: boolean): Promise<{ reference: WireReference; calls: number }> {
  const out = await bus.request<{ reference?: WireReference; model_calls?: number; error?: string }>("rpc.brain.follow_reference", {
    account_id: accountId, source_id: sourceId, jpeg_b64: jpeg.toString("base64"), box, ...(checked ? { checked: true } : {}),
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
    if (blurredOnly(req.access?.grants, img.sourceId)) throw new ApiError(403, "forbidden_sense", "this agent sees that camera only blurred", { blurred_only: true });
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

/** JPEG frames (at most 640 wide) of a camera's recordings at the given times; the nearest frame within 0.7 s of each. */
export async function framesAt(deps: Pick<FollowDeps, "data" | "storage" | "keys">, accountId: string, sourceId: string, times: number[]): Promise<{ t: number; jpeg: Buffer }[]> {
  if (!times.length) return [];
  const sorted = [...times].sort((a, b) => a - b);
  const rows = await deps.data.withAccount(accountId, (s) => segmentsIn(s, sourceId, sorted[0]! - 1, sorted.at(-1)! + 1));
  const needed = rows.filter((r) => {
    const start = new Date(r.start_at).getTime();
    return sorted.some((t) => t >= start && t < start + r.duration_ms);
  });
  if (!needed.length) return [];
  const dir = await mkdtemp(join(tmpdir(), "sp-follow-"));
  try {
    const runs = await segmentsToFiles(deps, accountId, sourceId, needed, dir, "r");
    const frames: { t: number; file: string }[] = [];
    for (const [i, run] of runs.entries()) {
      const out = join(dir, `f${i}`);
      await mkdir(out);
      await ffmpeg(["-y", "-i", run.file, "-an", "-vf", "fps=1,scale='min(640,iw)':-2", "-q:v", "5", join(out, "%05d.jpg")], 5 * 60_000);
      for (const f of (await readdir(out)).sort()) frames.push({ t: run.start + (Number(f.slice(0, 5)) - 1) * 1000, file: join(out, f) });
    }
    const picked = new Map<string, { t: number; jpeg: Buffer }>();
    for (const t of sorted) {
      let best: { t: number; file: string } | undefined;
      for (const f of frames) if (Math.abs(f.t - t) <= 700 && (!best || Math.abs(f.t - t) < Math.abs(best.t - t))) best = f;
      if (best && !picked.has(best.file)) picked.set(best.file, { t, jpeg: await readFile(best.file) });
    }
    return [...picked.values()].sort((a, b) => a.t - b.t);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

export function linkRoute(sightings: FoundSighting[], names: Map<string, string>, recorded: Map<string, { from: number; to: number }[]>, examined: { source_id: string; t: number }[]) {
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
    if (b.from - a.to > GAP_REPORT_MS) gaps.push({ from: iso(a.to), to: iso(b.from), note: gapNote(a.to, b.from, names, recorded, examined) });
  }
  return { visits, handovers, gaps };
}

const iso = (t: number) => new Date(t).toISOString();
const hhmmss = (t: number) => new Date(t).toISOString().slice(11, 19);

/** Why it wasn't seen, honestly: no camera recording, nothing looked at, or looked at and not there. */
function gapNote(from: number, to: number, names: Map<string, string>, recorded: Map<string, { from: number; to: number }[]>, examined: { source_id: string; t: number }[]) {
  const recording = [...recorded].filter(([, rs]) => rs.some((r) => r.from < to && r.to > from)).map(([id]) => names.get(id) ?? id);
  const looked = examined.filter((e) => e.t > from && e.t < to).length;
  const span = `${hhmmss(from)}–${hhmmss(to)} UTC`;
  if (!recording.length) return `${span}: not seen; no camera was recording then`;
  if (!looked) return `${span}: not checked; the frame limit was reached before this stretch`;
  return `${span}: not seen on ${recording.join(", ")} (${looked} frames looked at); it was somewhere no camera covers, or out of sight`;
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

export async function runFollow(deps: FollowDeps, accountId: string, id: string, log?: FastifyBaseLogger): Promise<void> {
  const row = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("follows").selectAll().where("id", "=", id).executeTakeFirst());
  if (!row) return;
  try {
    const out = await follow(deps, row, log);
    await deps.data.withAccount(accountId, (s) => s.db.updateTable("follows").set({
      status: "done", error: null, result: JSON.stringify(out.result), story_id: out.storyId, frames_examined: out.frames, model_calls: out.calls,
      finished_at: new Date(), due_at: null, claimed_until: null,
    }).where("id", "=", id).execute());
  } catch (err) {
    const refused = err instanceof ApiError && (err.details as { person?: boolean } | undefined)?.person === true;
    const final = refused || err instanceof FollowFailure || err instanceof ApiError || row.attempts >= MAX_ATTEMPTS;
    log?.warn({ err, follow: id, attempts: row.attempts }, final ? "follow failed" : "follow failed; will retry");
    await deps.data.withAccount(accountId, (s) => s.db.updateTable("follows").set(final
      ? { status: refused ? "refused" : "failed", error: err instanceof ApiError || err instanceof FollowFailure ? err.message : "the follow could not run", due_at: null, claimed_until: null, finished_at: new Date() }
      : { status: "queued", due_at: new Date(Date.now() + 30_000), claimed_until: null }).where("id", "=", id).execute());
  }
}

async function follow(deps: FollowDeps, row: FollowRow, log?: FastifyBaseLogger) {
  if (!deps.bus) throw new FollowFailure("no brain is connected");
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
  let reference: WireReference | undefined;
  if (ref.box && ref.source_id && ref.at) {
    const img = await referenceImage(deps, accountId, ref.event_id ? { event: ref.event_id } : { source: ref.source_id, at: ref.at });
    reference = (await brainReference(deps.bus, accountId, img.sourceId, img.jpeg, ref.box, true)).reference;
  }

  // What to look at: a frame budget shared between the cameras, in order of how much each recorded.
  const recorded = new Map<string, { from: number; to: number }[]>();
  const events = new Map<string, { from: number; to: number }[]>();
  for (const src of allowed) {
    const ranges = await deps.data.withAccount(accountId, (s) => recordedRanges(s, src.id, from, to));
    recorded.set(src.id, ranges.map((r) => ({ from: Math.max(from, r.from.getTime()), to: Math.min(to, r.to.getTime()) })));
    const evs = await deps.data.withAccount(accountId, (s) => s.db.selectFrom("events").select(["occurred_at", "ended_at"])
      .where("source_id", "=", src.id).where("occurred_at", ">=", new Date(from - 60_000)).where("occurred_at", "<", new Date(to)).orderBy("occurred_at").limit(500).execute());
    events.set(src.id, evs.map((e) => ({ from: new Date(e.occurred_at).getTime() - 2000, to: (e.ended_at ? new Date(e.ended_at).getTime() : new Date(e.occurred_at).getTime()) + 2000 })));
  }
  const share = Math.max(10, Math.floor(FOLLOW_LIMITS.frames / allowed.length));
  const sightings: FoundSighting[] = [];
  const examined: { source_id: string; t: number }[] = [];
  let frameLimit = false;
  for (const src of allowed) {
    const times = sampleTimes(recorded.get(src.id)!, events.get(src.id)!, share);
    if (times.length >= share) frameLimit = true;
    for (let i = 0; i < times.length; i += FOLLOW_LIMITS.batch * 3) {
      const frames = await framesAt(deps, accountId, src.id, times.slice(i, i + FOLLOW_LIMITS.batch * 3));
      for (let j = 0; j < frames.length; j += FOLLOW_LIMITS.batch) {
        const batch = frames.slice(j, j + FOLLOW_LIMITS.batch);
        if (!reference && !ref.description) throw new FollowFailure("the follow has no reference");
        const out = await deps.bus.request<{ sightings?: { t: string; box: number[]; confidence: number; confirmed: boolean | null }[]; frames_examined?: number; model_calls?: number; reference?: WireReference; error?: string }>(
          "rpc.brain.follow_scan", {
            account_id: accountId, source_id: src.id, budget: Math.max(0, FOLLOW_LIMITS.modelCalls - calls),
            ...(reference ? { reference } : { description: ref.description }),
            frames: batch.map((f) => ({ t: iso(f.t), jpeg_b64: f.jpeg.toString("base64") })),
          }, 120_000);
        if (out.error === "no_model") throw new FollowFailure("finding a thing from a description needs a vision model; draw a box around it instead");
        if (out.error) throw new Error(`brain: ${out.error}`);
        calls += out.model_calls ?? 0;
        if (out.reference) reference = out.reference;
        for (const f of batch) examined.push({ source_id: src.id, t: f.t });
        for (const s of out.sightings ?? []) sightings.push({ source_id: src.id, t: Date.parse(s.t), box: s.box, confidence: s.confidence, confirmed: s.confirmed });
      }
    }
  }
  const { visits, handovers, gaps } = linkRoute(sightings, names, recorded, examined);
  log?.info({ follow: row.id, frames: examined.length, sightings: sightings.length, visits: visits.length, calls }, "follow done");

  // The story of the route: each visit with a little either side, at most a minute of each.
  let storyId: string | null = null;
  let storyNote: string | undefined;
  if (row.make_story && visits.length) {
    const pieces = visits.slice(0, 20).map((v) => ({ source: v.source_id, from: iso(v.from - 2000), to: iso(Math.min(v.to + 3000, v.from + 60_000)) }));
    try {
      const story = await makeStory(deps, req, { title: `Route of ${ref.description ?? ref.label ?? "the object"}`.slice(0, 200), moments: pieces });
      storyId = story.story.id;
    } catch (err) {
      storyNote = err instanceof ApiError ? err.message : "the story could not be made";
    }
  }
  const result = {
    reference: { ...ref },
    route: visits.map((v) => ({ ...v, from: iso(v.from), to: iso(v.to), confidence: Number(v.confidence.toFixed(3)) })),
    handovers,
    gaps,
    ...(visits.length ? { first_seen: iso(visits[0]!.from), last_seen: iso(Math.max(...visits.map((v) => v.to))) } : {}),
    sightings: sightings.sort((a, b) => a.t - b.t).slice(0, 300).map((s) => ({ source_id: s.source_id, at: iso(s.t), box: s.box, confidence: s.confidence, confirmed: s.confirmed })),
    cameras: allowed.map((x) => ({ source_id: x.id, source_name: x.name, frames_examined: examined.filter((e) => e.source_id === x.id).length })),
    limits: { frames: FOLLOW_LIMITS.frames, frames_examined: examined.length, frame_limit_reached: frameLimit, model_calls: calls, model_calls_cap: FOLLOW_LIMITS.modelCalls },
    ...(storyNote ? { story_note: storyNote } : {}),
  };
  return { result, storyId, frames: examined.length, calls };
}

/** Claims follows waiting to run, one at a time per process. */
export function startFollowWorker(deps: FollowDeps, log: FastifyBaseLogger, intervalMs = 3000) {
  return startClaimLoop({
    name: "follows", intervalMs, log, kick: followKick, batch: 1,
    claim: async (max) => (await sql<{ id: string; account_id: string }>`select * from claim_follows(${max}, ${LEASE_S})`.execute(deps.data.db())).rows,
    handle: (r) => runFollow(deps, r.account_id, r.id, log),
  });
}
