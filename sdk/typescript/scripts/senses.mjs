// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// Writes src/generated/senses.ts from spec/senses.json (the known sensor senses).
import { readFileSync, writeFileSync } from "node:fs";
const { units, senses } = JSON.parse(readFileSync(new URL("../../../spec/senses.json", import.meta.url), "utf8"));
const field = (k, v) => (v === undefined ? "" : `, ${k}: ${JSON.stringify(v)}`);
const rows = senses.map((s) => `  { sense: ${JSON.stringify(s.sense)}, kind: ${JSON.stringify(s.kind)}, name: ${JSON.stringify(s.name)}${field("unit", s.unit)}${field("on", s.on)}${field("off", s.off)} },`);
const out = `// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// Generated from spec/senses.json. Do not edit; run \`pnpm codegen\`.

/** How each unit is shown. */
export const UNIT_SYMBOLS: Readonly<Record<string, string>> = ${JSON.stringify(units, null, 2).replace(/\n/g, "\n")};

/**
 * The known sensor senses (ADR 0060): numbers in a unit, on/off states (\`on\` is what true means)
 * and events. Readings of other senses are accepted too.
 */
export const SENSES = [
${rows.join("\n")}
] as const;
`;
writeFileSync(new URL("../src/generated/senses.ts", import.meta.url), out);
