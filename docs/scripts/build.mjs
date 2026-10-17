// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Builds the static docs site into docs/site/ (git-ignored):
//   api.html            REST API reference, rendered by Redoc (MIT) from spec/openapi.yaml
//   media-control.html  media control API reference, from spec/media/control-api.yaml
//   *.html              the guides in docs/, rendered from Markdown with marked (MIT)
// It also regenerates docs/api/mcp-tools.md from spec/mcp/tools.json and
// docs/api/labels.md from spec/labels.json, so neither drifts from the spec.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const docs = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(docs, "..");
const site = join(docs, "site");
const redocly = join(docs, "node_modules", ".bin", "redocly");

rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });

// 1. MCP tool reference, generated from the spec.
const tools = JSON.parse(readFileSync(join(root, "spec/mcp/tools.json"), "utf8"));
writeFileSync(join(docs, "api/mcp-tools.md"), renderTools(tools));
writeFileSync(join(docs, "api/labels.md"), renderLabels(JSON.parse(readFileSync(join(root, "spec/labels.json"), "utf8"))));

// 2. API references (Redoc). The public API gets a `curl` request sample on every
// operation, added to a bundled copy of the spec (the spec itself is untouched).
// No usage telemetry or update banners from the docs build.
const redoclyEnv = { ...process.env, REDOCLY_TELEMETRY: "off", REDOCLY_SUPPRESS_UPDATE_NOTICE: "true" };
const run = (args) => execFileSync(redocly, args, { stdio: ["ignore", "ignore", "inherit"], env: redoclyEnv });
const bundled = join(site, ".openapi.bundled.json");
run(["bundle", join(root, "spec/openapi.yaml"), "--output", bundled, "--ext", "json"]);
writeFileSync(bundled, JSON.stringify(withCurlSamples(JSON.parse(readFileSync(bundled, "utf8")))));
run(["build-docs", bundled, "--output", join(site, "api.html"), "--title", "Senseplane API reference"]);
rmSync(bundled);
run(["build-docs", join(root, "spec/media/control-api.yaml"), "--output", join(site, "media-control.html"), "--title", "Senseplane media control API"]);

// 3. Guides (Markdown → HTML). Paths are relative to the repo root.
const pages = [
  ["docs/README.md", "index.html"],
  ["docs/quickstart.md", "quickstart.html"],
  ["docs/mcp-setup.md", "mcp-setup.html"],
  ["docs/self-host.md", "self-host.html"],
  ["docs/self-host-vm.md", "self-host-vm.html"],
  ["docs/external-media-plane.md", "external-media-plane.html"],
  ["docs/lawful-use.md", "lawful-use.html"],
  ["docs/api/README.md", "api-guide.html"],
  ["docs/api/mcp-tools.md", "mcp-tools.html"],
  ["docs/api/labels.md", "labels.html"],
  ["spec/media/signalling.md", "media-signalling.html"],
  ["docs/architecture.md", "architecture.html"],
  ["docs/roadmap.md", "roadmap.html"],
  ["docs/watch-spec.md", "watch-spec.html"],
  ["docs/dev/phone-testing.md", "phone-testing.html"],
];
const outFor = new Map(pages.map(([src, out]) => [resolve(root, src), out]));
for (const [src, out] of pages) {
  const abs = resolve(root, src);
  const md = readFileSync(abs, "utf8");
  const html = marked.parse(md, { async: false });
  writeFileSync(join(site, out), shell(titleOf(md), rewriteLinks(html, dirname(abs))));
}
console.log(`docs site written to ${relative(process.cwd(), site) || "."}`);

/** Points links to other built pages at their .html file, and the rest at GitHub. */
function rewriteLinks(html, fromDir) {
  return html.replace(/href="([^"#:]+)(#[^"]*)?"/g, (whole, target, hash = "") => {
    const abs = resolve(fromDir, target);
    const built = outFor.get(abs);
    if (built) return `href="${built}${hash}"`;
    if (abs.startsWith(root)) {
      return `href="https://github.com/senseplane-ai/senseplane/blob/main/${relative(root, abs)}${hash}"`;
    }
    return whole;
  });
}

function titleOf(md) {
  return (md.match(/^#\s+(.+)$/m)?.[1] ?? "Senseplane docs").replace(/[`*]/g, "");
}

function shell(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Senseplane docs</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #e5e5e5; --code: #f5f5f5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b0b0c; --fg: #e8e8e8; --muted: #999; --line: #2a2a2a; --code: #161618; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, sans-serif; }
  nav { border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 14px; font-size: 14px; }
  nav a { color: var(--fg); text-decoration: none; } nav a:hover { text-decoration: underline; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
  a { color: inherit; } pre, code { background: var(--code); font-family: ui-monospace, Menlo, monospace; font-size: 14px; }
  pre { padding: 12px 14px; overflow-x: auto; border: 1px solid var(--line); } code { padding: 1px 4px; } pre code { padding: 0; }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; } th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
  blockquote { margin: 0; padding: 4px 16px; border-left: 3px solid var(--line); color: var(--muted); }
</style></head>
<body>
<nav><a href="index.html"><strong>Senseplane docs</strong></a><a href="quickstart.html">Quick start</a><a href="mcp-setup.html">MCP setup</a><a href="api-guide.html">API guide</a><a href="api.html">API reference</a><a href="mcp-tools.html">MCP tools</a><a href="self-host-vm.html">Run on a VM</a><a href="self-host.html">Self-host</a><a href="lawful-use.html">Lawful use</a></nav>
<main>${body}</main>
</body></html>
`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** Adds a curl sample to every operation, with a minimal body built from the request schema. */
function withCurlSamples(api) {
  const base = "http://localhost:58080/v1";
  for (const [path, item] of Object.entries(api.paths ?? {})) {
    for (const method of ["get", "post", "patch", "put", "delete"]) {
      const op = item[method];
      if (!op) continue;
      const security = op.security ?? api.security ?? [];
      const demo = security.some((s) => "demoToken" in s);
      const lines = [`curl -X ${method.toUpperCase()} "${base}${path}"`];
      if (security.length > 0) lines.push(`  -H "Authorization: Bearer ${demo ? "$DEMO_TOKEN" : "$SENSEPLANE_API_KEY"}"`);
      const schema = op.requestBody?.content?.["application/json"]?.schema;
      if (schema) {
        lines.push(`  -H "content-type: application/json"`);
        lines.push(`  -d '${JSON.stringify(sampleOf(resolveRef(api, schema), api, 0))}'`);
      }
      op["x-codeSamples"] = [{ lang: "curl", label: "curl", source: lines.join(" \\\n") }];
    }
  }
  return api;
}

function resolveRef(api, schema) {
  let s = schema;
  for (let i = 0; s?.$ref && i < 10; i++) {
    s = s.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[decodeURIComponent(k)], api);
  }
  return s ?? {};
}

function sampleOf(schema, api, depth) {
  const s = resolveRef(api, schema);
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum) return s.enum[0];
  if (s.const !== undefined) return s.const;
  const variant = s.oneOf ?? s.anyOf;
  if (variant) return sampleOf(variant.find((v) => resolveRef(api, v).type !== "null") ?? variant[0], api, depth);
  if (s.allOf) return Object.assign({}, ...s.allOf.map((v) => sampleOf(v, api, depth)));
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (type === "object" || s.properties) {
    if (depth > 3) return {};
    const out = {};
    const required = new Set(s.required ?? []);
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      if (required.has(k)) out[k] = sampleOf(v, api, depth + 1);
    }
    return out;
  }
  if (type === "array") return depth > 3 ? [] : [sampleOf(s.items ?? {}, api, depth + 1)];
  if (type === "integer") return s.minimum ?? 1;
  if (type === "number") return s.minimum ?? 0;
  if (type === "boolean") return false;
  if (s.format === "date-time") return "2026-10-14T21:00:00Z";
  if (s.format === "uri") return "https://example.com/hooks/senseplane";
  return "…";
}

function renderLabels(spec) {
  const coco = (l) => (l.coco.length > 1 ? `${l.coco.length} classes` : String(l.coco[0]));
  const words = (l) => (l.words ?? []).filter((w) => w.replace(/ /g, "_") !== l.label).join(", ");
  const row = (l) => `| \`${l.label}\` | ${l.name} | \`detection.${l.label}\`${l.events === false ? " (never posted)" : ""} | ${l.min_score ?? spec.default_min_score} | ${words(l)} | ${coco(l)} |`;
  return [
    "<!-- Generated by docs/scripts/build.mjs from spec/labels.json. Do not edit by hand. -->",
    "",
    "# Detector labels",
    "",
    `The fast detector (YOLOX on the 80 COCO classes) reports ${spec.labels.length} labels. \`person\`, \`vehicle\``,
    "(bicycle, car, motorcycle, bus, truck) and `animal` (bird, cat, dog, horse, sheep, cow, elephant, bear,",
    "zebra, giraffe) group COCO classes; every other class is one everyday object with its own label.",
    "",
    "Each label is an `objects` trigger `label` and the event type `detection.<label>`; subscribe a",
    "webhook to `detection.*` for all of them, or filter `GET /v1/events?type=detection.*`.",
    "An event is posted once the track's best score reaches the minimum score. Everyday objects post",
    "fewer events than people: none for what is in view when the camera starts, at most one per label",
    "per camera every 5 minutes, and none at all for fixtures and furniture (\"never posted\"), which",
    "still work in watches. The watch compiler maps the listed words to the label.",
    "",
    "| Label | Name | Event type | Min score | Words the compiler maps | COCO |",
    "|---|---|---|---|---|---|",
    ...spec.labels.map(row),
    "",
  ].join("\n");
}

function renderTools(spec) {
  const lines = [
    "<!-- Generated by docs/scripts/build.mjs from spec/mcp/tools.json. Do not edit by hand. -->",
    "",
    "# MCP tools",
    "",
    `Senseplane's MCP server exposes ${spec.tools.length} tools (tool spec version ${spec.version}).`,
    "Each call runs with the agent's grants: a tool that needs a sense the agent",
    "isn't granted fails with `forbidden_sense`. See [MCP setup](../mcp-setup.md)",
    "to connect a client.",
    "",
  ];
  for (const tool of spec.tools) {
    lines.push(`## \`${tool.name}\``, "", tool.description, "");
    const props = tool.inputSchema?.properties ?? {};
    const required = new Set(tool.inputSchema?.required ?? []);
    const names = Object.keys(props);
    if (names.length === 0) {
      lines.push("**Input:** none.", "");
    } else {
      lines.push("| Input | Type | Required | Notes |", "|---|---|---|---|");
      for (const name of names) {
        const p = props[name];
        lines.push(`| \`${name}\` | ${typeOf(p)} | ${required.has(name) ? "yes" : "no"} | ${notesOf(p)} |`);
      }
      lines.push("");
    }
    if (tool.output) lines.push(`**Returns:** ${tool.output}`, "");
  }
  return lines.join("\n");
}

function typeOf(p) {
  if (p.enum) return p.enum.map((v) => `\`${v}\``).join(", ");
  if (Array.isArray(p.type)) return p.type.join(" or ");
  if (p.type === "array") return `array of ${p.items ? typeOf(p.items) : "any"}`;
  return p.type ?? (p.anyOf || p.oneOf ? "see notes" : "any");
}

function notesOf(p) {
  const notes = [];
  if (p.description) notes.push(p.description);
  if (p.minimum !== undefined) notes.push(`min ${p.minimum}`);
  if (p.maximum !== undefined) notes.push(`max ${p.maximum}`);
  if (p.maxLength !== undefined) notes.push(`up to ${p.maxLength} characters`);
  if (p.default !== undefined) notes.push(`default \`${JSON.stringify(p.default)}\``);
  if (p.type === "object" && p.properties) notes.push(`fields: ${Object.keys(p.properties).map((k) => `\`${k}\``).join(", ")}`);
  return notes.join("; ").replace(/\|/g, "\\|") || "";
}
