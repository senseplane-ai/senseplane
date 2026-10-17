// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Most API tests need Postgres (TEST_ADMIN_DATABASE_URL) and a few need the
// object store (TEST_S3_ENDPOINT), as the compose stack provides them. When
// one isn't reachable, the files that need it are skipped with a note, so
// `pnpm -r test` stays green on a machine without the stack.
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { configDefaults, defineConfig } from "vitest/config";

const PG = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://senseplane:senseplane@localhost:55432/senseplane";
const S3 = process.env.TEST_S3_ENDPOINT ?? "http://localhost:59000";

function reachable(url: string, port: number): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = connect({ host: u.hostname, port: Number(u.port || port) });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(1500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export default defineConfig(async () => {
  const [pg, s3] = await Promise.all([reachable(PG, 5432), reachable(S3, 80)]);
  const skipped: string[] = [];
  for (const f of readdirSync(new URL("./src", import.meta.url)).filter((x) => x.endsWith(".test.ts"))) {
    const text = readFileSync(new URL(`./src/${f}`, import.meta.url), "utf8");
    if ((!pg && text.includes("./testdb.js")) || (!s3 && text.includes("TEST_S3_ENDPOINT"))) skipped.push(`src/${f}`);
  }
  if (skipped.length) {
    const why = [!pg && `Postgres isn't reachable at ${new URL(PG).host} (TEST_ADMIN_DATABASE_URL)`, !s3 && `object storage isn't reachable at ${new URL(S3).host} (TEST_S3_ENDPOINT)`].filter(Boolean);
    console.warn(`\n[api] skipping ${skipped.length} test files: ${why.join("; ")}. Start the compose infrastructure (docker compose up) or point the variables at one.\n`);
  }
  return { test: { exclude: [...configDefaults.exclude, ...skipped], passWithNoTests: true } };
});
