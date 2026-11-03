// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { SENSES, UNIT_SYMBOLS } from "./generated/senses.js";

export { SENSES, UNIT_SYMBOLS };

export type ReadingKind = "number" | "state" | "event";

/** A known sense's entry in spec/senses.json. */
export interface SenseInfo {
  sense: string;
  kind: ReadingKind;
  name: string;
  unit?: string;
  on?: string;
  off?: string;
}

const BY_SENSE: ReadonlyMap<string, SenseInfo> = new Map(SENSES.map((s) => [s.sense, s as SenseInfo]));

/** The catalog entry of a known sensor sense, else undefined. */
export function senseInfo(sense: string): SenseInfo | undefined {
  return BY_SENSE.get(sense);
}

/** video and audio are camera senses, and control (switching devices, ADR 0067) and speak (talking through a camera, ADR 0069) are permissions; every other sense is a sensor's. */
export function isSensorSense(sense: string): boolean {
  return sense !== "video" && sense !== "audio" && sense !== "control" && sense !== "speak";
}

/** What people read for a sense ("door or window", "power use"); unknown ones read as words. */
export function senseName(sense: string): string {
  return BY_SENSE.get(sense)?.name ?? sense.replace(/_/g, " ");
}

/** The word for a state's value: contact true → "open", switch false → "off"; unknown senses read on/off. */
export function stateWord(sense: string, value: boolean): string {
  const s = BY_SENSE.get(sense);
  return (value ? s?.on : s?.off) ?? (value ? "on" : "off");
}

/** How a unit is shown: celsius → °C, watt → W; unknown units as they are. */
export function unitSymbol(unit: string): string {
  return UNIT_SYMBOLS[unit] ?? unit.replace(/_/g, " ");
}

/** A reading in a few words: "21.5 °C", "open", "pressed (double)". */
export function readingText(r: { sense: string; kind?: ReadingKind; value?: number | boolean; unit?: string; state?: string; detail?: string }): string {
  const kind = r.kind ?? (typeof r.value === "boolean" ? "state" : r.value === undefined ? "event" : "number");
  if (kind === "state") return r.state ?? stateWord(r.sense, r.value === true);
  if (kind === "event") {
    const verb = r.sense === "doorbell" ? "rang" : r.sense === "button" ? "pressed" : "happened";
    return r.detail ? `${verb} (${r.detail})` : verb;
  }
  const n = typeof r.value === "number" ? Math.round(r.value * 10) / 10 : r.value;
  const sym = r.unit ? unitSymbol(r.unit) : "";
  return sym === "%" ? `${n}%` : `${n}${sym ? ` ${sym}` : ""}`;
}
