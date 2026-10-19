// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Validates spec/: every JSON Schema compiles, openapi.yaml and the media
// contract resolve all $refs, and the MCP tools have valid input schemas.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import $RefParser from "@apidevtools/json-schema-ref-parser";
import YAML from "yaml";
import { synced } from "./labels.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// spec/labels.json: every COCO class exactly once, unique labels, and the enums that repeat it in sync.
const labelDoc = JSON.parse(readFileSync(join(root, "labels.json"), "utf8"));
const coco = labelDoc.labels.flatMap((l) => l.coco).sort((a, b) => a - b);
if (coco.length !== 80 || coco.some((c, i) => c !== i)) throw new Error("labels.json must map each COCO class 0-79 exactly once");
const labelNames = labelDoc.labels.map((l) => l.label);
if (new Set(labelNames).size !== labelNames.length) throw new Error("labels.json has a duplicate label");
for (const l of labelDoc.labels) if (!/^[a-z][a-z_]*$/.test(l.label) || !l.name) throw new Error(`labels.json: bad entry ${JSON.stringify(l)}`);
for (const [file, before, after] of synced()) {
  if (before !== after) throw new Error(`${file} is out of sync with labels.json: run \`pnpm --filter @senseplane/spec labels\``);
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);

const schemaDir = join(root, "schemas");
const schemas = readdirSync(schemaDir).filter((f) => f.endsWith(".json"));
for (const f of schemas) ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), "utf8")));
for (const f of schemas) {
  const id = `https://senseplane.com/schemas/${f}`;
  if (!ajv.getSchema(id)) throw new Error(`schema ${f} did not compile`);
}

const sampleEvent = {
  id: "evt_01J9ZZZZZZZZZZZZZZZZZZZZZZ",
  type: "watch.triggered",
  watch_id: "wat_01J9ZZZZZZZZZZZZZZZZZZZZZZ",
  source: { id: "src_frontdoor", sense: "video", location: "Front door" },
  occurred_at: "2026-10-14T21:02:11+02:00",
  summary: "A courier left a brown box on the doormat.",
  labels: ["person", "package"],
  confidence: 0.91,
  value: null,
  media: { snapshot_url: "https://example.com/s.jpg", clip_url: "https://example.com/c.m3u8" },
};
const validateEvent = ajv.getSchema("https://senseplane.com/schemas/event.json");
if (!validateEvent(sampleEvent)) throw new Error(`sample event invalid: ${ajv.errorsText(validateEvent.errors)}`);

for (const file of ["openapi.yaml", "media/control-api.yaml", "media/whip.yaml"]) {
  const doc = YAML.parse(readFileSync(join(root, file), "utf8"));
  // Schema $ids live under https://senseplane.com/schemas/; resolve them from disk, never the network.
  await $RefParser.dereference(join(root, file), doc, {
    resolve: {
      http: false,
      senseplane: {
        order: 1,
        canRead: /^https:\/\/senseplane\.com\/schemas\//,
        read: (f) => readFileSync(join(schemaDir, f.url.split("/").pop()), "utf8"),
      },
    },
  });
  if (doc.openapi !== "3.1.0") throw new Error(`${file}: expected OpenAPI 3.1.0`);
}

const { tools } = JSON.parse(readFileSync(join(root, "mcp/tools.json"), "utf8"));
if (tools.length !== 10) throw new Error(`expected 10 MCP tools, found ${tools.length}`);
for (const t of tools) ajv.compile(t.inputSchema);

// The media contract's callbacks and token vectors (spec/media, ADR 0049).
const callbacks = JSON.parse(readFileSync(join(root, "media/callbacks.json"), "utf8"));
ajv.addSchema(callbacks);
for (const def of Object.keys(callbacks.$defs)) {
  if (!ajv.getSchema(`${callbacks.$id}#/$defs/${def}`)) throw new Error(`callbacks ${def} did not compile`);
}
const vectors = JSON.parse(readFileSync(join(root, "media/vectors/tokens.json"), "utf8"));
const vectorReasons = new Set(vectors.cases.filter((c) => !c.expect.ok).map((c) => c.expect.reason));
for (const r of ["malformed", "unknown_kid", "bad_signature", "expired", "not_yet_valid", "ttl_too_long", "wrong_audience", "wrong_issuer", "bad_claims", "bad_transport"]) {
  if (!vectorReasons.has(r)) throw new Error(`media token vectors: no case is refused with ${r}`);
}

const brain = JSON.parse(readFileSync(join(root, "brain/valkey.json"), "utf8"));
for (const [name, s] of Object.entries(brain.messages)) {
  try { ajv.compile(s.schema); } catch (e) { throw new Error(`brain message ${name}: ${e.message}`); }
}
for (const [name, k] of Object.entries(brain.kv)) {
  if (typeof k.value === "object") try { ajv.compile(k.value); } catch (e) { throw new Error(`brain kv ${name}: ${e.message}`); }
}
for (const [name, r] of Object.entries(brain.requests ?? {})) {
  try { ajv.compile(r.request); ajv.compile(r.reply); } catch (e) { throw new Error(`brain request ${name}: ${e.message}`); }
}

const signalling = JSON.parse(readFileSync(join(root, "media/signalling.json"), "utf8"));
ajv.addSchema(signalling);
for (const def of ["request", "response", "event", "joinClaims", "controlClaims", "whipClaims"]) {
  if (!ajv.getSchema(`${signalling.$id}#/$defs/${def}`)) throw new Error(`signalling ${def} did not compile`);
}
const validReq = ajv.getSchema(`${signalling.$id}#/$defs/request`);
if (!validReq({ method: "join", id: 1, protocolVersion: 1, token: "x" })) throw new Error("join frame example invalid");
if (validReq({ method: "join", id: 1, protocolVersion: 2, token: "x" })) throw new Error("protocolVersion 2 should be rejected");
// Every claim set the vectors accept is a valid claim set by the schema, and the schema refuses what the vectors call bad_claims.
const claimSchema = { media: "joinClaims", control: "controlClaims", whip: "whipClaims" };
for (const c of vectors.cases) {
  const validate = ajv.getSchema(`${signalling.$id}#/$defs/${claimSchema[c.audience]}`);
  if (c.expect.ok && !validate(c.expect.claims)) throw new Error(`vector "${c.name}": accepted claims fail the schema: ${ajv.errorsText(validate.errors)}`);
}

console.log(`spec ok: ${schemas.length} schemas, ${labelNames.length} labels, openapi + media contract resolved, ${tools.length} MCP tools, ${vectors.cases.length} media token vectors`);
