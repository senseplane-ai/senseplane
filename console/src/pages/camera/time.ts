// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

export const DAY_MS = 86400_000;

/** Fraction of the local day [0, 1] for a timestamp, relative to `dayStart`. */
export const dayFraction = (t: number, dayStart: number) => Math.min(1, Math.max(0, (t - dayStart) / DAY_MS));

export const pct = (t: number, dayStart: number) => `${(dayFraction(t, dayStart) * 100).toFixed(3)}%`;

/** "11:42" or "11:42:08" in 24 h local time. */
export function clock(t: number, seconds = false): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
}

/** "TODAY 11:42:08", "YESTERDAY 23:10:00" or "16 OCT 09:00:00". */
export function dayLabel(t: number, now = Date.now()): string {
  const d = new Date(t);
  const today = new Date(now);
  const yesterday = new Date(now - DAY_MS);
  const day = d.toDateString() === today.toDateString()
    ? "TODAY"
    : d.toDateString() === yesterday.toDateString()
      ? "YESTERDAY"
      : d.toLocaleDateString([], { day: "numeric", month: "short" }).toUpperCase();
  return `${day} ${clock(t, true)}`;
}

/** Clamps `t` into the recorded ranges: inside one, it stays; in a gap, it moves to the next range's start (or the last end). */
export function snapToRecorded(t: number, ranges: { from: number; to: number }[]): number {
  if (!ranges.length) return t;
  for (const r of ranges) {
    if (t < r.from) return r.from;
    if (t <= r.to) return t;
  }
  return Math.max(ranges[ranges.length - 1]!.to - 2 * 60_000, ranges[ranges.length - 1]!.from);
}
