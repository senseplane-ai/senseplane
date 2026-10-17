// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Watch schedules (ADR 0043): `active_hours` is wall-clock time in a time zone,
// so it follows daylight saving. A span whose `to` is before its `from` runs
// overnight and belongs to the day it starts on (Friday 18:00–06:00 includes
// Saturday 03:00). `from` == `to` means the whole day. The brain has the same
// rules in watches.py; keep them in step.
import type { WatchSchedule } from "./data/schema.js";

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return f;
}

export function validTimeZone(tz: string): boolean {
  // IANA names only: the brain resolves them with zoneinfo, which has no "+02:00" offsets.
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Day (0 = Monday) and "HH:MM" of an instant in a time zone. */
export function localTime(at: Date, timeZone = "UTC") {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(at).map((p) => [p.type, p.value]));
  const day = DAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3) as (typeof DAYS)[number]);
  return { day, hhmm: `${parts.hour}:${parts.minute}` };
}

type Span = { days?: readonly string[]; from: string; to: string };

export function inSpan(span: Span, local: { day: number; hhmm: string }): boolean {
  const days = span.days?.length ? span.days : DAYS;
  const today = DAYS[local.day]!;
  const yesterday = DAYS[(local.day + 6) % 7]!;
  if (span.from === span.to) return days.includes(today);
  if (span.from < span.to) return days.includes(today) && local.hhmm >= span.from && local.hhmm < span.to;
  if (local.hhmm >= span.from) return days.includes(today);
  if (local.hhmm < span.to) return days.includes(yesterday);
  return false;
}

/** Whether a watch may fire at `at`: its schedule (if any) and the compiler's UTC active_hours (if any) both allow it. */
export function activeAt(at: Date, schedule: WatchSchedule | null | undefined, compiled?: Span[] | null): boolean {
  if (schedule && !inSpan(schedule, localTime(at, schedule.time_zone ?? "UTC"))) return false;
  if (compiled?.length && !compiled.some((s) => inSpan(s, localTime(at, "UTC")))) return false;
  return true;
}

/** Problems with a schedule from a request, or undefined when it is valid. */
export function scheduleProblem(s: WatchSchedule): string | undefined {
  if (!HHMM.test(s.from) || !HHMM.test(s.to)) return "active_hours.from and .to must be HH:MM (00:00–23:59)";
  if (s.days && s.days.some((d) => !(DAYS as readonly string[]).includes(d))) return `active_hours.days must be among ${DAYS.join(", ")}`;
  if (s.time_zone !== undefined && !validTimeZone(s.time_zone)) return `unknown time zone "${s.time_zone}" (use an IANA name such as Europe/London)`;
  return undefined;
}
