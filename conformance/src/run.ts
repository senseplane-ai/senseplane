// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The media contract's black-box conformance suite (spec/media). Runs every
// group against the media plane named by the environment and prints a
// table; exits 1 on any failure. See conformance/README.md.
import { writeFileSync } from "node:fs";
import { chromePath, startBrowser } from "./browser.ts";
import { type Config, type Result, Signer, loadConfig, startCallbackServer } from "./kit.ts";
import { controlApi } from "./groups/control.ts";
import { feed } from "./groups/feed.ts";
import { signalling } from "./groups/signalling.ts";
import { tokens } from "./groups/tokens.ts";
import { whip } from "./groups/whip.ts";

export async function runSuite(c: Config = loadConfig()): Promise<Result[]> {
  const s = new Signer(c);
  const cb = await startCallbackServer(c);
  const chrome = chromePath(c.chrome);
  const browser = chrome ? await startBrowser(chrome) : undefined;
  const wants = (g: string) => !c.only || c.only.includes(g);
  const results: Result[] = [];
  const group = async (name: string, needsBrowser: boolean, fn: () => Promise<Result[]>) => {
    if (!wants(name)) return;
    if (needsBrowser && !browser) {
      results.push({ group: name, name: "skipped: Chrome not found (CHROME_PATH)", ok: false });
      return;
    }
    console.log(`\n# ${name}`);
    try {
      results.push(...(await fn()));
    } catch (err) {
      results.push({ group: name, name: `crashed: ${(err as Error).message}`, ok: false });
      console.log(`  FAIL ${name}: crashed: ${(err as Error).stack}`);
    }
  };
  try {
    await group("tokens", false, () => tokens(c, s));
    await group("control", false, () => controlApi(c, s, cb));
    await group("signalling", true, () => signalling(c, s, browser!));
    await group("whip", true, () => whip(c, s, cb, browser!));
    await group("feed", true, () => feed(c, s, cb, browser!));
  } finally {
    await browser?.close();
    await cb.close();
  }
  return results;
}

export function table(results: Result[]) {
  const groups = [...new Set(results.map((r) => r.group))];
  const rows = groups.map((g) => {
    const rs = results.filter((r) => r.group === g);
    return { group: g, pass: rs.filter((r) => r.ok).length, fail: rs.filter((r) => !r.ok).length };
  });
  const out = ["group        pass  fail", ...rows.map((r) => `${r.group.padEnd(12)} ${String(r.pass).padStart(4)}  ${String(r.fail).padStart(4)}`)];
  const failed = results.filter((r) => !r.ok);
  if (failed.length) out.push("", "failed:", ...failed.map((f) => `  ${f.group}: ${f.name}`));
  return out.join("\n");
}

if (process.argv[1] === import.meta.filename) {
  const results = await runSuite();
  console.log(`\n${table(results)}`);
  if (process.env.CONFORMANCE_RESULTS) writeFileSync(process.env.CONFORMANCE_RESULTS, JSON.stringify(results, null, 2));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
