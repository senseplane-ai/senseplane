// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Activities and questions about them (ADR 0057): POST /v1/activity/query
// answers one structured question; GET /v1/activities lists the intervals.
// Both apply the caller's grants: presence and watch activities need the
// video sense on their source, sound activities the audio sense, sensors their
// own sense, each within the grant's time window.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { grantWindowsFor, seesSource } from "../access.js";
import { type ActivityQuery, type Interval, type Loader, QueryError, type SourceInfo, type What, answer } from "../activity-query.js";
import type { AccountScope, DataAccess } from "../data/access.js";
import { ApiError } from "../errors.js";
import { STALE_ACTIVITY_S } from "../activity.js";
import { recordedRanges } from "./playback.js";

/** The sense an activity of this kind needs. */
export const senseFor = (w: What) => (w.sensor ? w.sensor.sense : w.sound ? "audio" : "video");

/** The windows a caller may see a sense on a source in, clipped to [from, to); one full window for account keys. */
function allowed(req: FastifyRequest | undefined, sourceId: string, sense: string, from: number, to: number): [number, number][] {
  const w = req ? grantWindowsFor(req.access?.grants, sourceId, sense) : "all";
  if (w === "all") return [[from, to]];
  return w.map((g) => [Math.max(from, g.from?.getTime() ?? -Infinity), Math.min(to, g.to?.getTime() ?? Infinity)] as [number, number]).filter(([a, b]) => b > a);
}

function within(ivs: Interval[], wins: [number, number][]): Interval[] {
  const out: Interval[] = [];
  for (const i of ivs) for (const [a, b] of wins) {
    const s = Math.max(i.start, a);
    const e = Math.min(i.end, b);
    if (e > s || (i.start === i.end && i.start >= a && i.start < b)) out.push({ ...i, start: s, end: Math.max(s, e) });
  }
  return out;
}

/** Reads intervals and coverage for the query engine, inside one account and the caller's grants. */
export function dbLoader(s: AccountScope, req: FastifyRequest | undefined, now = Date.now()): Loader {
  return {
    async intervals(what, ids, from, to) {
      const sense = senseFor(what);
      const out: Interval[] = [];
      if (what.sensor) {
        const { sense: name, above, below } = what.sensor;
        for (const id of ids) {
          const wins = allowed(req, id, name, from, to);
          if (!wins.length) continue;
          const rows = await s.db.selectFrom("sensor_readings").select(["value", "measured_at"]).where("source_id", "=", id).where("sense", "=", name)
            .where("measured_at", ">=", new Date(from)).where("measured_at", "<", new Date(to)).orderBy("measured_at").limit(50_000).execute();
          const pts = rows.map((r) => ({ t: new Date(r.measured_at).getTime(), v: Number(r.value) }));
          if (above === undefined && below === undefined) {
            out.push(...within(pts.map((p, i) => ({ id: `rdg_${id}_${i}`, source_id: id, zone: null, start: p.t, end: p.t, open: false, count: 1, value: p.v })), wins));
            continue;
          }
          // Spans where the threshold holds: from the first reading over it until the next reading that isn't.
          const hit = (v: number) => (above === undefined || v > above) && (below === undefined || v < below);
          let cur: Interval | undefined;
          pts.forEach((p, i) => {
            if (hit(p.v)) {
              if (!cur) cur = { id: `rdg_${id}_${i}`, source_id: id, zone: null, start: p.t, end: p.t, open: false, count: 1, value: p.v };
              cur.end = p.t;
              cur.value = above !== undefined ? Math.max(cur.value!, p.v) : Math.min(cur.value!, p.v);
            } else if (cur) {
              cur.end = p.t;
              out.push(...within([cur], wins));
              cur = undefined;
            }
          });
          if (cur) out.push(...within([{ ...cur, open: now - cur.end < 15 * 60_000, end: now - cur.end < 15 * 60_000 ? Math.min(now, to) : cur.end }], wins));
        }
        return out;
      }
      const kind = what.watch_id ? "watch" : what.sound ? "sound" : "presence";
      const label = what.watch_id ?? what.sound ?? what.label!;
      const visible = ids.filter((id) => allowed(req, id, sense, from, to).length);
      if (!visible.length) return [];
      let q = s.db.selectFrom("activities").select(["id", "source_id", "zone", "started_at", "ended_at", "last_seen_at", "peak_count", "summary"])
        .where("kind", "=", kind).where("label", "=", label).where("source_id", "in", visible)
        .where("started_at", "<", new Date(to))
        .where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">=", new Date(from))]));
      if (kind === "presence") q = what.zone ? q.where("zone", "=", what.zone) : q.where("zone", "is", null);
      const rows = await q.orderBy("started_at").limit(20_000).execute();
      for (const r of rows) {
        const lastSeen = new Date(r.last_seen_at).getTime();
        const live = !r.ended_at && now - lastSeen < STALE_ACTIVITY_S * 1000;
        const iv: Interval = {
          id: r.id, source_id: r.source_id, zone: r.zone, start: new Date(r.started_at).getTime(),
          end: r.ended_at ? new Date(r.ended_at).getTime() : live ? now : lastSeen, open: live, count: r.peak_count, summary: r.summary,
        };
        out.push(...within([iv], allowed(req, r.source_id, sense, from, to)));
      }
      return out;
    },
    async coverage(what, ids, from, to) {
      if (what.sensor) return null;
      const sense = senseFor(what);
      const out = new Map<string, [number, number][]>();
      for (const id of ids) {
        const wins = allowed(req, id, sense, from, to);
        const ranges = wins.length ? await recordedRanges(s, id, from, to) : [];
        out.set(id, within(ranges.map((r, i) => ({ id: String(i), source_id: id, zone: null, start: r.from.getTime(), end: r.to.getTime(), open: false, count: 0 })), wins)
          .map((i) => [i.start, i.end]));
      }
      return out;
    },
  };
}

/** The sources a question may use: the ones named (by id or name), else all the caller sees. */
export async function scope(s: AccountScope, req: FastifyRequest | undefined, names?: string[]): Promise<SourceInfo[]> {
  const all = (await s.db.selectFrom("sources").select(["id", "name", "site"]).execute()).filter((x) => !req || seesSource(req, x.id));
  if (!names?.length) return all;
  const out: SourceInfo[] = [];
  for (const n of names) {
    const hit = all.find((x) => x.id === n) ?? all.find((x) => x.name.toLowerCase() === String(n).toLowerCase());
    if (!hit) throw new ApiError(404, "not_found", `source not found: ${n}`);
    if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Answers a question inside an account (also used by the chat tool). */
export async function ask(data: DataAccess, accountId: string, req: FastifyRequest | undefined, q: ActivityQuery, now = Date.now()) {
  return data.withAccount(accountId, async (s) => {
    const sources = await scope(s, req, q.sources);
    if (q.what?.watch_id) {
      const w = await s.db.selectFrom("watches").select("id").where("id", "=", q.what.watch_id).executeTakeFirst();
      if (!w) throw new ApiError(404, "not_found", `watch not found: ${q.what.watch_id}`);
    }
    try {
      return await answer(q, sources, dbLoader(s, req, now), now);
    } catch (err) {
      if (err instanceof QueryError) throw new ApiError(400, "validation_failed", err.message);
      throw err;
    }
  });
}

export function registerActivityRoutes(app: FastifyInstance, deps: { data: DataAccess }) {
  app.post<{ Body: ActivityQuery }>("/v1/activity/query", async (req) => {
    if (!req.body || typeof req.body !== "object" || !req.body.what) throw new ApiError(400, "validation_failed", "body must be an activity query with `measure` and `what`");
    return ask(deps.data, req.accountId!, req, req.body);
  });

  app.get<{ Querystring: { source?: string; kind?: string; label?: string; zone?: string; from?: string; to?: string; limit?: string } }>("/v1/activities", async (req) => {
    const to = req.query.to ? Date.parse(req.query.to) : Date.now();
    const from = req.query.from ? Date.parse(req.query.from) : to - 86_400_000;
    if (Number.isNaN(from) || Number.isNaN(to) || to <= from) throw new ApiError(400, "validation_failed", "from and to must be RFC 3339 times, from before to");
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 500);
    return deps.data.withAccount(req.accountId!, async (s) => {
      const sources = await scope(s, req, req.query.source ? [req.query.source] : undefined);
      const names = new Map(sources.map((x) => [x.id, x.name]));
      let q = s.db.selectFrom("activities").selectAll().where("source_id", "in", sources.length ? sources.map((x) => x.id) : ["-"])
        .where("started_at", "<", new Date(to)).where((eb) => eb.or([eb("ended_at", "is", null), eb("ended_at", ">=", new Date(from))]));
      if (req.query.kind) q = q.where("kind", "=", req.query.kind as "presence");
      if (req.query.label) q = q.where("label", "=", req.query.label);
      if (req.query.zone) q = q.where("zone", "=", req.query.zone);
      const rows = await q.orderBy("started_at", "desc").limit(limit * 2).execute();
      const now = Date.now();
      const data = rows.filter((r) => allowed(req, r.source_id, r.kind === "sound" ? "audio" : "video", from, to).length).slice(0, limit).map((r) => {
        const live = !r.ended_at && now - new Date(r.last_seen_at).getTime() < STALE_ACTIVITY_S * 1000;
        const end = r.ended_at ? new Date(r.ended_at).getTime() : live ? now : new Date(r.last_seen_at).getTime();
        return {
          id: r.id, source: { id: r.source_id, name: names.get(r.source_id) ?? r.source_id }, kind: r.kind, label: r.label, zone: r.zone,
          watch_id: r.watch_id, started_at: new Date(r.started_at).toISOString(), ended_at: r.ended_at ? new Date(r.ended_at).toISOString() : null,
          ongoing: live, duration_s: Math.round((end - new Date(r.started_at).getTime()) / 100) / 10, peak_count: r.peak_count,
          confidence: r.confidence, verified: r.verified, summary: r.summary, checked: r.checked,
        };
      });
      return { data };
    });
  });
}
