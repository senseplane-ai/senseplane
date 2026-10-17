// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Every production npm dependency (what ships in the images and the console
// bundle) must carry an allowed licence (CONTRIBUTING.md). Pull requests also
// run GitHub's dependency review on what they change, for npm, Python and Go.
//   node scripts/check-licenses.mjs     (after pnpm install)
import { execFileSync } from "node:child_process";

// Permissive licences. SPDX expressions with OR pass when one side is allowed.
const ALLOWED = new Set(["MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Apache-2.0", "MPL-2.0", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Python-2.0", "Unlicense"]);
// Named exceptions: fonts the console bundles (SIL Open Font Licence, for fonts, not code).
const EXCEPTIONS = [{ name: /^@fontsource\//, license: "OFL-1.1" }];

const ok = (expr) => expr.replace(/[()]/g, "").split(/\s+OR\s+/).some((alt) => alt.split(/\s+AND\s+/).every((l) => ALLOWED.has(l.trim())));

const list = JSON.parse(execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], { maxBuffer: 64 * 1024 * 1024 }).toString());
const bad = [];
let count = 0;
for (const [license, pkgs] of Object.entries(list)) {
  for (const p of pkgs) {
    count++;
    if (ok(license) || EXCEPTIONS.some((e) => e.name.test(p.name) && e.license === license)) continue;
    bad.push(`${p.name}@${p.versions?.join(",") ?? "?"}: ${license}`);
  }
}
if (bad.length) {
  console.error(`licences not on the allow-list (CONTRIBUTING.md):\n  ${bad.join("\n  ")}`);
  process.exit(1);
}
console.log(`${count} production npm packages, all on the licence allow-list`);
