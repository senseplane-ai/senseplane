// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// spec/labels.json is the one list of detector labels. This keeps the enums
// that repeat it in sync: the objects trigger's `label`, the Event `type`
// (detection.<label>) and the brain.event message type.
// `node scripts/labels.mjs` rewrites them; validate.mjs fails when they drift.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const labels = () => JSON.parse(readFileSync(join(root, "labels.json"), "utf8")).labels.map((l) => l.label);

/** Puts detection.<label> for every label in place of the existing detection.* entries, keeping the other types in order. */
const withDetections = (types, names) => {
  const at = types.findIndex((t) => t.startsWith("detection."));
  const rest = types.filter((t) => !t.startsWith("detection."));
  const i = at < 0 ? rest.length : at;
  return [...rest.slice(0, i), ...names.map((n) => `detection.${n}`), ...rest.slice(i)];
};

// Python's json.dumps(indent=2) escapes non-ASCII; brain/valkey.json is written that way.
const asciiJson = (doc) => JSON.stringify(doc, null, 2).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n";
const plainJson = (doc) => JSON.stringify(doc, null, 2) + "\n";

/** [file, current text, text with the enums from labels.json]. */
export function synced() {
  const names = labels();
  const out = [];
  const edit = (file, fmt, fn) => {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    const doc = JSON.parse(text);
    fn(doc);
    out.push([file, text, fmt(doc)]);
  };
  edit("schemas/trigger.json", plainJson, (d) => { d.$defs.objects.properties.label.enum = names; });
  edit("schemas/event.json", plainJson, (d) => { d.properties.type.enum = withDetections(d.properties.type.enum, names); });
  edit("brain/valkey.json", asciiJson, (d) => {
    const t = d.messages["brain.event"].schema.properties.type;
    t.enum = withDetections(t.enum, names);
  });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [file, before, after] of synced()) {
    if (before !== after) {
      writeFileSync(join(root, file), after);
      console.log(`labels: updated ${file}`);
    }
  }
}
