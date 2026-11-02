// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Sensor readings beyond climate (ADR 0060): numbers in a unit, on/off states
// and events. Known senses come from spec/senses.json; others are taken with
// the kind they state. States are stored as 1/0 and events as 1.
import catalog from "./generated/senses.json" with { type: "json" };
import { ApiError } from "./errors.js";

export type Kind = "number" | "state" | "event";

interface SenseEntry { sense: string; kind: Kind; unit?: string; on?: string; off?: string; name: string; words: string[] }

export const SENSES: ReadonlyMap<string, SenseEntry> = new Map((catalog.senses as SenseEntry[]).map((s) => [s.sense, s]));
export const UNIT_SYMBOLS: Readonly<Record<string, string>> = catalog.units;

/** Camera senses; every other sense is a sensor's. */
export const MEDIA_SENSES = new Set(["video", "audio"]);
export const isSensorSense = (sense: string) => !MEDIA_SENSES.has(sense);

/** A reading as pushed (POST /v1/sources/{id}/readings). */
export interface ReadingInput {
  sense: string;
  kind?: Kind;
  value?: number | boolean;
  unit?: string;
  detail?: string;
  device?: { id: string; name?: string };
  measured_at?: string;
  at?: string;
}

/** A reading checked and ready to store. */
export interface CleanReading {
  sense: string;
  kind: Kind;
  value: number;
  unit: string;
  detail: string | null;
  device_id: string | null;
  device_name: string | null;
  at: Date;
}

const deviceSchema = {
  type: "object", required: ["id"], additionalProperties: false,
  properties: { id: { type: "string", minLength: 1, maxLength: 200 }, name: { type: "string", maxLength: 200 } },
};

/** JSON schema of one pushed reading. */
export const readingInputSchema = {
  type: "object", required: ["sense"], additionalProperties: false,
  // `at` is accepted as an alias of `measured_at` (integrations, ADR 0045).
  properties: {
    sense: { type: "string", pattern: "^[a-z][a-z0-9_]*$", maxLength: 40 },
    kind: { enum: ["number", "state", "event"] },
    value: { anyOf: [{ type: "number" }, { type: "boolean" }] },
    unit: { type: "string", pattern: "^[a-z0-9_]{1,32}$" },
    detail: { type: "string", maxLength: 64 },
    device: deviceSchema,
    measured_at: { type: "string" },
    at: { type: "string" },
  },
};

const bad = (msg: string) => new ApiError(400, "validation_failed", msg);

/** Checks one pushed reading against the catalog; throws validation_failed. */
export function cleanReading(r: ReadingInput, now = new Date()): CleanReading {
  if (MEDIA_SENSES.has(r.sense)) throw bad(`${r.sense} is a camera sense, not a reading`);
  const known = SENSES.get(r.sense);
  const kind: Kind = r.kind ?? known?.kind ?? (typeof r.value === "boolean" ? "state" : r.value === undefined ? "event" : "number");
  if (known && known.kind !== kind) throw bad(`${r.sense} is a${known.kind === "event" ? "n" : ""} ${known.kind} reading`);
  const when = r.measured_at ?? r.at;
  const at = when ? new Date(when) : now;
  if (Number.isNaN(at.getTime())) throw bad("measured_at must be an RFC 3339 time");
  const device = { device_id: r.device?.id ?? null, device_name: r.device?.name ?? null };
  if (kind === "number") {
    if (typeof r.value !== "number" || !Number.isFinite(r.value)) throw bad(`${r.sense} needs a number value`);
    if (!r.unit) throw bad(`${r.sense} needs a unit${known?.unit ? ` (${known.unit})` : ""}`);
    if (known?.unit && known.unit !== r.unit) throw bad(`${r.sense} is measured in ${known.unit}`);
    if (r.detail !== undefined) throw bad("detail is for events");
    return { sense: r.sense, kind, value: r.value, unit: r.unit, detail: null, ...device, at };
  }
  if (r.unit !== undefined) throw bad(`${r.sense} is a ${kind} and has no unit`);
  if (kind === "state") {
    if (typeof r.value !== "boolean") throw bad(`${r.sense} needs value true or false`);
    if (r.detail !== undefined) throw bad("detail is for events");
    return { sense: r.sense, kind, value: r.value ? 1 : 0, unit: "state", detail: null, ...device, at };
  }
  if (r.value !== undefined && r.value !== true) throw bad(`${r.sense} is an event and takes no value`);
  return { sense: r.sense, kind, value: 1, unit: "event", detail: r.detail ?? null, ...device, at };
}

/** The word for a state: contact 1 → "open", switch 0 → "off"; unknown senses read on/off. */
export function stateWord(sense: string, value: number | boolean): string {
  const on = value === true || value === 1;
  const s = SENSES.get(sense);
  return (on ? s?.on : s?.off) ?? (on ? "on" : "off");
}

/** What people read for a sense ("door or window"); unknown ones as words. */
export const senseName = (sense: string) => SENSES.get(sense)?.name ?? sense.replace(/_/g, " ");

/** A stored row (sensor_readings) as the API returns it (spec/schemas/reading.json). */
export interface ReadingRow {
  sense: string;
  kind?: Kind | string;
  value: number;
  unit: string;
  detail?: string | null;
  device_id?: string | null;
  device_name?: string | null;
  measured_at: Date | string;
}

export interface ReadingOut {
  sense: string;
  kind: Kind;
  value?: number | boolean;
  unit?: string;
  state?: string;
  since?: string;
  detail?: string;
  device?: { id: string; name?: string };
  measured_at: string;
}

export function toReading(r: ReadingRow, since?: Date | string | null): ReadingOut {
  const kind = (r.kind ?? "number") as Kind;
  const base = {
    sense: r.sense, kind,
    ...(r.device_id ? { device: { id: r.device_id, ...(r.device_name ? { name: r.device_name } : {}) } } : {}),
    measured_at: new Date(r.measured_at).toISOString(),
  };
  if (kind === "state") return { ...base, value: r.value === 1, state: stateWord(r.sense, r.value), ...(since ? { since: new Date(since).toISOString() } : {}) };
  if (kind === "event") return { ...base, ...(r.detail ? { detail: r.detail } : {}) };
  return { ...base, value: r.value, unit: r.unit };
}

/** A reading in a few words: "21.5 °C", "open", "rang". */
export function readingText(r: { sense: string; kind?: string; value: number; unit: string; detail?: string | null }): string {
  if (r.kind === "state") return stateWord(r.sense, r.value);
  if (r.kind === "event") {
    const verb = r.sense === "doorbell" ? "rang" : r.sense === "button" ? "pressed" : "happened";
    return r.detail ? `${verb} (${r.detail})` : verb;
  }
  const n = Math.round(r.value * 100) / 100;
  const sym = UNIT_SYMBOLS[r.unit] ?? r.unit.replace(/_/g, " ");
  return sym === "%" ? `${n}%` : `${n} ${sym}`;
}

/** A sensor trigger or activity filter (spec/schemas/trigger.json $defs.sensor). */
export interface SensorMatch {
  sense: string;
  device?: string;
  above?: number;
  below?: number;
  state?: boolean;
  detail?: string;
}

/** Does a reading come from the device a trigger names (its id or name, any case)? No device named: every device. */
export function deviceMatches(m: { device?: string }, r: { device_id?: string | null; device_name?: string | null }): boolean {
  if (!m.device) return true;
  const want = m.device.toLowerCase();
  return r.device_id?.toLowerCase() === want || r.device_name?.toLowerCase() === want;
}

/**
 * Is this reading "in" the condition: a number above/below, a state with the
 * wanted value (default true: open, on, wet, ...), an event (with the detail, if one is named).
 */
export function holds(m: SensorMatch, r: { kind?: string; value: number; detail?: string | null }): boolean {
  if (r.kind === "state") return (r.value === 1) === (m.state ?? true);
  if (r.kind === "event") return !m.detail || r.detail === m.detail;
  if (m.above === undefined && m.below === undefined) return true;
  return (m.above !== undefined && r.value > m.above) || (m.below !== undefined && r.value < m.below);
}

/** A short description of a sensor condition: "door or window open", "power use above 2000 W". */
export function conditionText(m: SensorMatch): string {
  const s = SENSES.get(m.sense);
  const who = m.device ?? senseName(m.sense);
  if (s?.kind === "state" || m.state !== undefined) return `${who} ${stateWord(m.sense, m.state ?? true)}`;
  if (s?.kind === "event") return `${who}${m.detail ? ` (${m.detail})` : ""}`;
  const sym = s?.unit ? (UNIT_SYMBOLS[s.unit] ?? s.unit) : "";
  const parts = [m.above !== undefined && `above ${m.above}${sym ? ` ${sym}` : ""}`, m.below !== undefined && `below ${m.below}${sym ? ` ${sym}` : ""}`].filter(Boolean);
  return parts.length ? `${who} ${parts.join(" or ")}` : who;
}
