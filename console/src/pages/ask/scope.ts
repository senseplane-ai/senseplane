// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The composer's time choices and how they turn into a from/to window.
import { startOfToday, timeOf } from "../../shell/sources";

export type TimeChoice = "today" | "hour" | "24h" | "yesterday" | "week" | "any";

export const TIME_CHOICES: { id: TimeChoice; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "hour", label: "Last hour" },
  { id: "24h", label: "Last 24 hours" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "Last 7 days" },
  { id: "any", label: "Any time" },
];

export function windowFor(choice: TimeChoice, now = new Date()): { from?: string; to?: string } {
  const t = now.getTime();
  const day = startOfToday(now);
  const iso = (ms: number) => new Date(ms).toISOString();
  switch (choice) {
    case "today": return { from: iso(day), to: iso(t) };
    case "hour": return { from: iso(t - 3600_000), to: iso(t) };
    case "24h": return { from: iso(t - 86400_000), to: iso(t) };
    case "yesterday": return { from: iso(day - 86400_000), to: iso(day) };
    case "week": return { from: iso(t - 7 * 86400_000), to: iso(t) };
    default: return {};
  }
}

/** "09:00–16:05" for a same-day window, "Mon 09:00–Tue 10:00" otherwise. */
export function windowLabel(w: { from?: string; to?: string }): string {
  if (!w.from || !w.to) return "ANY TIME";
  const a = new Date(w.from), b = new Date(w.to);
  if (a.toDateString() === b.toDateString()) return `${timeOf(a.getTime(), false)}–${timeOf(b.getTime(), false)}`;
  const d = (x: Date) => x.toLocaleDateString([], { weekday: "short" });
  return `${d(a)} ${timeOf(a.getTime(), false)}–${d(b)} ${timeOf(b.getTime(), false)}`;
}
