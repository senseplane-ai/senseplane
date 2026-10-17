// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The m1 check: ingest end to end against the compose stack (API and media as separate
// containers) with headless Chrome and a fake camera:
//   1. create an account + API key (admin CLI in the api container)
//   2. POST /v1/sources → capture_url
//   3. open the capture page, stream for STREAM_SECONDS
//   4. while streaming: measure how fresh the segment index is, and that the
//      last minute downloads from object storage as continuous H.264
//   5. press Stop; check the source goes offline
// Prereqs: `docker compose --profile app up -d` (deploy/compose) and
// `pnpm --filter @senseplane/console build && pnpm --filter @senseplane/console exec vite preview --port 5173 --strictPort`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import puppeteer from "puppeteer-core";
import { compose } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STREAM_SECONDS = Number(process.env.STREAM_SECONDS ?? 90);
const db = new pg.Client({ connectionString: process.env.E2E_DB_URL ?? "postgres://senseplane:senseplane@localhost:55432/senseplane" });
const s3 = new S3Client({
  endpoint: process.env.E2E_S3_URL ?? "http://localhost:59000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "senseplane", secretAccessKey: "senseplane-secret" },
});
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const { api_key: apiKey } = JSON.parse(
  execFileSync("docker", [...compose, "exec", "-T", "api", "node", "dist/cli.js", "create-account", "E2E"]).toString().trim().split("\n").pop()!,
);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const source = await call("POST", "/v1/sources", { name: "E2E fake camera", type: "browser" });
log("source created", { id: source.id });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-sandbox"],
});
const page = await browser.newPage();
page.on("console", (m) => m.type() === "error" && log("browser error", { text: m.text() }));
const startedAt = Date.now();
await page.goto(source.ingest.capture_url);
await page.waitForFunction("window.__senseplaneCapture && window.__senseplaneCapture.state() === 'live'", { timeout: 20_000 });
log("capture page live", { ms: Date.now() - startedAt });

await db.connect();
const segments = async () =>
  (
    await db.query(
      "select key, init_key, start_at, duration_ms, indexed_at from segments where source_id = $1 order by start_at",
      [source.id],
    )
  ).rows as { key: string; init_key: string; start_at: Date; duration_ms: number; indexed_at: Date }[];

// Freshness: how far behind "now" is the end of the newest indexed segment.
const lags: number[] = [];
let firstIndexedMs: number | undefined;
while (Date.now() - startedAt < STREAM_SECONDS * 1000) {
  await new Promise((r) => setTimeout(r, 2000));
  const rows = await segments();
  if (!rows.length) continue;
  firstIndexedMs ??= Date.now() - startedAt;
  const last = rows.at(-1)!;
  const end = new Date(last.start_at).getTime() + last.duration_ms;
  if (Date.now() - startedAt > 20_000) lags.push(Date.now() - end);
}

// "Last minute" playable now: the segments covering [now-75 s, now] downloaded and concatenated.
const now = Date.now();
const rows = (await segments()).filter((r) => new Date(r.start_at).getTime() + r.duration_ms > now - 75_000);
const get = async (Key: string) =>
  Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: "senseplane", Key }))).Body!.transformToByteArray());
const dir = mkdtempSync(join(tmpdir(), "sp-e2e-"));
const file = join(dir, "last-minute.mp4");
const tFetch = Date.now();
writeFileSync(file, Buffer.concat([await get(rows[0]!.init_key), ...(await Promise.all(rows.map((r) => get(r.key))))]));
const fetchMs = Date.now() - tFetch;
const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).toString());
const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
let gaps = 0;
for (let i = 1; i < rows.length; i++) {
  const prevEnd = new Date(rows[i - 1]!.start_at).getTime() + rows[i - 1]!.duration_ms;
  if (new Date(rows[i]!.start_at).getTime() - prevEnd > 1500) gaps++;
}
const coveredFrom = new Date(rows[0]!.start_at).getTime();
const coveredTo = new Date(rows.at(-1)!.start_at).getTime() + rows.at(-1)!.duration_ms;

await page.click("#stop");
await page.waitForFunction("window.__senseplaneCapture.state() === 'stopped'", { timeout: 10_000 });
await new Promise((r) => setTimeout(r, 3000));
const after = await call("GET", `/v1/sources/${source.id}`);
await browser.close();
await db.end();

const result = {
  streamedSeconds: STREAM_SECONDS,
  firstSegmentIndexedAfterMs: firstIndexedMs,
  indexLagMs: { max: Math.max(...lags), median: lags.sort((a, b) => a - b)[Math.floor(lags.length / 2)] },
  lastMinute: {
    segments: rows.length,
    coveredSeconds: Number(((coveredTo - coveredFrom) / 1000).toFixed(1)),
    newestEndsSecondsBeforeCheck: Number(((now - coveredTo) / 1000).toFixed(1)),
    gapsOver1_5s: gaps,
    downloadMs: fetchMs,
    playableSeconds: Number(Number(probe.format.duration).toFixed(1)),
    video: `${v.codec_name} ${v.profile} ${v.width}x${v.height}`,
  },
  sourceStatusAfterStop: after.status,
  pass:
    Math.max(...lags) <= 15_000 && (coveredTo - coveredFrom) >= 60_000 && gaps === 0 && v.codec_name === "h264" && after.status === "offline",
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
