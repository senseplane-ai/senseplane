// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Wall-clock arithmetic in an IANA time zone, for questions about "today",
// "nights" and "the same weekday" (ADR 0057), across daylight saving changes.

export interface WallTime { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number } // dow 0 = Monday

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function wall(at: Date | number, timeZone: string): WallTime {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { y: +p.year!, m: +p.month!, d: +p.day!, hh: +p.hour!, mm: +p.minute!, ss: +p.second!, dow: DOW.indexOf(String(p.weekday)) };
}

/** The offset from UTC a zone has at an instant, in ms. */
function offsetAt(t: number, timeZone: string): number {
  const w = wall(t, timeZone);
  return Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) - Math.floor(t / 1000) * 1000;
}

/**
 * The instant a wall-clock time names in a time zone. In a repeated hour (clocks go back) it is the earlier one;
 * in a skipped hour (clocks go forward) the time moves forward by the gap, so 01:30 on the night London skips
 * 01:00–02:00 is 02:30 BST. The brain's zoneinfo (fold=0) agrees.
 */
export function fromWall(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
  const named = Date.UTC(y, m - 1, d, hh, mm);
  // The offsets a day either side bracket any change of offset near this time.
  const before = offsetAt(named - 86400_000, timeZone);
  const after = offsetAt(named + 86400_000, timeZone);
  const fits = [named - before, named - after].filter((t) => offsetAt(t, timeZone) === named - t);
  if (fits.length) return Math.min(...fits);
  return named - before;
}

/** Local midnight of the day `at` falls on, `days` days later (negative: earlier). */
export function localMidnight(at: number, timeZone: string, days = 0): number {
  const w = wall(at, timeZone);
  const day = new Date(Date.UTC(w.y, w.m - 1, w.d + days));
  return fromWall(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, timeZone);
}

/** Shifts an instant by whole local days, keeping its wall-clock time (23 h or 25 h across DST). */
export function shiftDays(at: number, days: number, timeZone: string): number {
  const w = wall(at, timeZone);
  const day = new Date(Date.UTC(w.y, w.m - 1, w.d + days));
  return fromWall(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), w.hh, w.mm, timeZone) + w.ss * 1000 + (at % 1000);
}

export const hhmmMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/**
 * The parts of [from, to) inside a daily wall-clock window (`from` > `to` runs overnight: 22:00–06:00 covers
 * the night into the next day).
 */
export function dailyWindows(from: number, to: number, win: { from: string; to: string }, timeZone: string): [number, number][] {
  const a = hhmmMinutes(win.from);
  const b = hhmmMinutes(win.to);
  const out: [number, number][] = [];
  for (let day = localMidnight(from, timeZone, -1); day < to; day = localMidnight(day, timeZone, 1)) {
    const w = wall(day, timeZone);
    const start = fromWall(w.y, w.m, w.d, Math.floor(a / 60), a % 60, timeZone);
    let end = fromWall(w.y, w.m, w.d, Math.floor(b / 60), b % 60, timeZone);
    if (b <= a) end = shiftDays(end, 1, timeZone);
    const s = Math.max(start, from);
    const e = Math.min(end, to);
    if (e > s) out.push([s, e]);
  }
  return out;
}
