// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Backtesting a watch over recorded history (POST /v1/watches/test, ADR 0043).
// The brain keeps no per-frame analysis, but every detection it made is an
// event (one per label per episode, with a snapshot, zones, start and end) and
// every sound it heard is one too; sensor readings are stored as they arrive.
// The cheap trigger is replayed over those; the model check (if the watch has
// one) then runs on at most `max_checks` candidate snapshots.
import type { EventRow } from "./events.js";
import type { WatchSchedule } from "./data/schema.js";
import { activeAt } from "./schedule.js";

type Trig = Record<string, any> & { type: string };
export interface Compiled {
  trigger: Trig;
  verify?: { prompt: string; min_confidence: number };
  cooldown_s: number;
  active_hours: { days: string[]; from: string; to: string }[] | null;
}
export interface Reading { sense: string; value: number; unit: string; measured_at: Date | string }
export interface Candidate {
  source_id: string;
  at: number;
  /** The stored event the moment came from (absent for sensor readings). */
  event?: EventRow;
  reading?: { sense: string; value: number; unit: string };
}

const ms = (d: Date | string) => new Date(d).getTime();

/** Moments one trigger fires at on one source, from that source's stored events (time order). */
export function moments(trig: Trig, events: EventRow[], readings: Reading[] = []): Omit<Candidate, "source_id">[] {
  switch (trig.type) {
    case "objects": {
      const evs = events.filter((e) => e.type === `detection.${trig.label}` && (!trig.zone || e.zones.includes(trig.zone)));
      const minDur = Number(trig.min_duration_s ?? 0) * 1000;
      if (trig.on === "leave") return evs.filter((e) => e.ended_at).map((e) => ({ at: ms(e.ended_at!), event: e }));
      if (trig.on === "present" || trig.on === "stationary") {
        // Held for min_duration: the episode lasted at least that long (or is still going on).
        return evs.filter((e) => !minDur || !e.ended_at || ms(e.ended_at) - ms(e.occurred_at) >= minDur).map((e) => ({ at: ms(e.occurred_at) + minDur, event: e }));
      }
      return evs.map((e) => ({ at: ms(e.occurred_at), event: e }));
    }
    case "motion":
      // Motion itself isn't stored; something detected moving in the zone stands in for it.
      return events.filter((e) => e.type.startsWith("detection.") && (!trig.zone || e.zones.includes(trig.zone))).map((e) => ({ at: ms(e.occurred_at), event: e }));
    case "sound":
      return events.filter((e) => e.type === "sound.detected" && e.labels.includes(trig.class)).map((e) => ({ at: ms(e.occurred_at), event: e }));
    case "schedule": {
      // The stored snapshots, at most one per interval.
      const out: Omit<Candidate, "source_id">[] = [];
      for (const e of events.filter((x) => x.snapshot_key)) {
        if (!out.length || ms(e.occurred_at) - out.at(-1)!.at >= Number(trig.every_min) * 60_000) out.push({ at: ms(e.occurred_at), event: e });
      }
      return out;
    }
    case "sequence": {
      const steps = (trig.steps as Trig[]).map((s) => moments(s, events, readings).sort((a, b) => a.at - b.at));
      const within = Number(trig.within_s) * 1000;
      const out: Omit<Candidate, "source_id">[] = [];
      let after = -Infinity;
      for (const first of steps[0] ?? []) {
        if (first.at < after) continue; // already part of an earlier match
        let t = first.at;
        let last: Omit<Candidate, "source_id"> | undefined = first;
        for (const step of steps.slice(1)) {
          last = step.find((m) => m.at >= t && m.at - first.at <= within);
          if (!last) break;
          t = last.at;
        }
        if (last) {
          out.push({ ...last, event: last.event ?? first.event });
          after = last.at;
        }
      }
      return out;
    }
    case "sensor": {
      const out: Omit<Candidate, "source_id">[] = [];
      const isOut = (v: number) => (trig.above !== undefined && v > trig.above) || (trig.below !== undefined && v < trig.below);
      const minDur = Number(trig.min_duration_s ?? 0) * 1000;
      let runStart: number | undefined;
      let fired = false;
      for (const r of readings.filter((x) => x.sense === trig.sense).sort((a, b) => ms(a.measured_at) - ms(b.measured_at))) {
        const t = ms(r.measured_at);
        if (!isOut(r.value)) {
          runStart = undefined;
          fired = false;
          continue;
        }
        runStart ??= t;
        if (!fired && t - runStart >= minDur) {
          fired = true; // one per out-of-range run, as the live watch does
          out.push({ at: t, reading: { sense: r.sense, value: r.value, unit: r.unit } });
        }
      }
      return out;
    }
    default:
      return [];
  }
}

/** Candidates across sources: trigger moments inside the schedule, with the watch's cooldown per source. */
export function candidates(
  compiled: Compiled, schedule: WatchSchedule | null | undefined,
  bySource: Map<string, { events: EventRow[]; readings?: Reading[] }>, range: { from: number; to: number },
): Candidate[] {
  const out: Candidate[] = [];
  for (const [sourceId, { events, readings }] of bySource) {
    let last = -Infinity;
    for (const m of moments(compiled.trigger, events, readings).sort((a, b) => a.at - b.at)) {
      if (m.at < range.from || m.at > range.to) continue;
      if (!activeAt(new Date(m.at), schedule, compiled.active_hours)) continue;
      if (m.at - last < compiled.cooldown_s * 1000) continue;
      last = m.at;
      out.push({ source_id: sourceId, ...m });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
