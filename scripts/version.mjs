// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The release version lives in one place: "version" in the root package.json.
// Image references name its release line (0.1 for 0.1.3): the one-file compose
// (docker-compose.yml), the bridge command the API hands out, and the docs.
//
//   node scripts/version.mjs check              every ghcr.io/senseplane-ai/<image>:<x.y> is the release line
//   node scripts/version.mjs check --tag v0.1.3 also: the tag is the version (the release workflow)
//   node scripts/version.mjs set 0.2.0          bump the version and rewrite every reference
//   node scripts/version.mjs get                print the version
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "package.json");
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
// An image reference with a release-line tag (x.y, not x.y.z, edge or a commit).
const REF = /(ghcr\.io\/senseplane-ai\/[a-z0-9-]+):(\d+\.\d+)(?![.\w-])/g;

const readVersion = () => JSON.parse(readFileSync(PKG, "utf8")).version;
const lineOf = (v) => {
  const m = SEMVER.exec(v ?? "");
  if (!m) throw new Error(`root package.json version "${v}" isn't semver (x.y.z)`);
  return `${m[1]}.${m[2]}`;
};

/** Tracked text files that may name an image (lockfiles and binaries skipped). */
function files() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT }).toString().split("\0")
    .filter((f) => f && /\.(ya?ml|md|ts|tsx|js|mjs|json|sh|toml)$/.test(f) && !/(^|\/)(pnpm-lock\.yaml|uv\.lock|package-lock\.json)$/.test(f));
}

function refs() {
  const out = [];
  for (const f of files()) {
    let text;
    try {
      text = readFileSync(join(ROOT, f), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    for (const m of text.matchAll(REF)) out.push({ file: f, line: text.slice(0, m.index).split("\n").length, image: m[1], tag: m[2] });
  }
  return out;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "get") {
  console.log(readVersion());
} else if (cmd === "check") {
  const version = readVersion();
  const line = lineOf(version);
  const problems = [];
  const tagAt = args.indexOf("--tag");
  if (tagAt >= 0) {
    const tag = args[tagAt + 1] ?? "";
    if (tag !== `v${version}`) problems.push(`tag ${tag} isn't v${version} (root package.json): bump the version first (node scripts/version.mjs set ${tag.replace(/^v/, "")})`);
  }
  const found = refs();
  const stale = found.filter((r) => r.tag !== line);
  for (const r of stale) problems.push(`${r.file}:${r.line}: ${r.image}:${r.tag} should be :${line}`);
  if (!found.some((r) => r.file === "docker-compose.yml")) problems.push("docker-compose.yml names no ghcr.io/senseplane-ai image with a release-line tag");
  if (problems.length) {
    const fix = stale.length ? `\nFix the references with: node scripts/version.mjs set ${version}` : "";
    console.error(`version ${version} (release line ${line}):\n  ${problems.join("\n  ")}${fix}`);
    process.exit(1);
  }
  console.log(`version ${version}: ${found.length} image references on :${line}`);
} else if (cmd === "set") {
  const version = args[0];
  const line = lineOf(version);
  const pkg = readFileSync(PKG, "utf8");
  writeFileSync(PKG, pkg.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`));
  const changed = new Set();
  for (const f of new Set(refs().map((r) => r.file))) {
    const path = join(ROOT, f);
    const before = readFileSync(path, "utf8");
    const after = before.replace(REF, `$1:${line}`);
    if (after !== before) {
      writeFileSync(path, after);
      changed.add(f);
    }
  }
  console.log(`version ${version}; release line ${line} in: package.json${[...changed].map((f) => `, ${f}`).join("")}`);
} else {
  console.error("usage: node scripts/version.mjs check [--tag vX.Y.Z] | set X.Y.Z | get");
  process.exit(2);
}
