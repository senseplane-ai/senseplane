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

/** The instant a wall-clock time names in a time zone (the earlier one in a repeated hour). */
export function fromWall(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const w = wall(t, timeZone);
    const shown = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
    t += guess - shown;
  }
  return t;
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
