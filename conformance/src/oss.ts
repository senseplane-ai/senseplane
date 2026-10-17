// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Runs the suite against the open-source media server (media/dist, build it
// first): a throwaway key pair, the server as a child process on free ports,
// the suite, then the server is stopped. What CI runs.
//   pnpm --filter @senseplane/media build && node conformance/src/oss.ts
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./kit.ts";
import { runSuite, table } from "./run.ts";

const free = () => new Promise<number>((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => resolve(port));
  });
});

const keys = generateKeyPairSync("ed25519");
const priv = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
const pub = Buffer.from(keys.publicKey.export({ type: "spki", format: "pem" }).toString()).toString("base64");
const port = await free();
const rtc = 47000 + Math.floor(Math.random() * 500);
const server = new URL("../../media/dist/server.js", import.meta.url).pathname;
const child: ChildProcess = spawn(process.execPath, [server], {
  env: {
    ...process.env, PORT: String(port), MEDIA_TOKEN_PUBLIC_KEYS: `cf-1:${pub}`, MEDIA_INSTANCE_ID: "conformance",
    MEDIA_URL: `ws://127.0.0.1:${port}/`, MEDIA_LISTEN_IP: "127.0.0.1", MEDIA_ANNOUNCED_ADDRESS: "127.0.0.1", MEDIA_RTC_PORT: String(rtc),
    MEDIA_WORKERS: "1", MEDIA_WORK_DIR: mkdtempSync(join(tmpdir(), "sp-conformance-")), LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const stop = () => {
  if (child.exitCode === null) child.kill("SIGTERM");
};
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});
let ready = false;
for (let i = 0; i < 100 && !ready; i++) {
  ready = await fetch(`http://127.0.0.1:${port}/control/healthz`).then((r) => r.ok, () => false);
  if (!ready) await new Promise((r) => setTimeout(r, 200));
}
if (!ready) {
  stop();
  throw new Error("the media server did not start");
}
const results = await runSuite(loadConfig({
  ...process.env,
  CONFORMANCE_CONTROL_URL: `http://127.0.0.1:${port}`,
  CONFORMANCE_SIGNING_KEY: `cf-1:${priv}`,
  CONFORMANCE_ISSUER: "conformance",
  CONFORMANCE_CALLBACK_PORT: String(await free()),
}));
stop();
console.log(`\nOSS media server\n${table(results)}`);
if (process.env.CONFORMANCE_RESULTS) writeFileSync(process.env.CONFORMANCE_RESULTS, JSON.stringify(results, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
