// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// Writes src/generated/labels.ts from spec/labels.json (the detector's labels).
import { readFileSync, writeFileSync } from "node:fs";
const { labels } = JSON.parse(readFileSync(new URL("../../../spec/labels.json", import.meta.url), "utf8"));
const rows = labels.map((l) => `  { label: ${JSON.stringify(l.label)}, name: ${JSON.stringify(l.name)}${l.group ? ", group: true" : ""}${l.events === false ? ", events: false" : ""} },`);
const out = `// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// Generated from spec/labels.json. Do not edit; run \`pnpm codegen\`.

/**
 * What the fast detector reports: an \`objects\` trigger label and the event type \`detection.<label>\`.
 * \`group\` labels cover several COCO classes; \`events: false\` labels work in watches but post no detection events.
 */
export const LABELS = [
${rows.join("\n")}
] as const;
`;
writeFileSync(new URL("../src/generated/labels.ts", import.meta.url), out);
