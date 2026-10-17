// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { LABELS } from "./generated/labels.js";

export { LABELS };

/** A detector label: `person`, `vehicle`, `animal`, or one everyday object such as `cup`, `laptop` or `phone`. */
export type Label = (typeof LABELS)[number]["label"];

const NAMES: ReadonlyMap<string, string> = new Map(LABELS.map((l) => [l.label, l.name]));

/** The readable name of a label ("Cup", "Teddy bear"); unknown labels read as words ("glass_break" → "Glass break"). */
export function labelName(label: string): string {
  const known = NAMES.get(label);
  if (known) return known;
  const words = label.replace(/_/g, " ");
  return words ? words[0]!.toUpperCase() + words.slice(1) : label;
}

/** The label of a detection.<label> event type, or null for other types. */
export function detectionLabel(type: string): string | null {
  return type.startsWith("detection.") ? type.slice("detection.".length) : null;
}

/** True for a label the detector reports, so `isLabel(x)` narrows x to Label. */
export function isLabel(label: string): label is Label {
  return NAMES.has(label);
}
