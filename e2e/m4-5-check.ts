// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The m4-5 check: the website's /try page against a local stack, in headless
// Chrome. A "laptop" page starts a demo and shows the QR/link; a "phone" page
// (mobile emulation, fake camera playing the doorstep fixture) opens the link
// and streams. The laptop must show the camera live, events, a live answer and
// a memory answer; ending the demo must disconnect the phone, and the sweeper
// must delete the account and its objects.
//
//   SITE_URL=http://127.0.0.1:3002 E2E_API_URL=http://localhost:48080 FAKE_VIDEO=…/doorstep.y4m tsx m4-5-check.ts
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import puppeteer, { KnownDevices, type Page } from "puppeteer-core";

const SITE = process.env.SITE_URL ?? "http://127.0.0.1:3002";
const API = process.env.E2E_API_URL ?? "http://localhost:48080";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FAKE_VIDEO = process.env.FAKE_VIDEO;
const db = new pg.Client({ connectionString: process.env.E2E_DB_URL ?? "postgres://senseplane:senseplane@localhost:55432/senseplane" });
const s3 = new S3Client({
  endpoint: process.env.E2E_S3_URL ?? "http://localhost:59000", region: "us-east-1", forcePathStyle: true,
  credentials: { accessKeyId: "senseplane", secretAccessKey: "senseplane-secret" },
});
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const results: Record<string, unknown> = {};
const text = (p: Page, sel: string) => p.$eval(sel, (e) => (e as HTMLElement).innerText).catch(() => "");
const waitText = (p: Page, needle: string | RegExp, timeout: number) =>
  waitTextRaw(p, needle, timeout).catch(async (err) => {
    log("timed out", { needle: String(needle), page: (await text(p, "body")).slice(0, 600), errors: consoleErrors.slice(-5) });
    throw err;
  });
const consoleErrors: string[] = [];
const waitTextRaw = (p: Page, needle: string | RegExp, timeout: number) =>
  p.waitForFunction((n: string, re: boolean) => (re ? new RegExp(n) : null)?.test(document.body.innerText) ?? document.body.innerText.includes(n),
    { timeout, polling: 500 }, typeof needle === "string" ? needle : needle.source, typeof needle !== "string");

await db.connect();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-sandbox", ...(FAKE_VIDEO ? [`--use-file-for-fake-video-capture=${FAKE_VIDEO}`] : [])],
});
try {
  // Laptop: start the demo.
  const laptop = await browser.newPage();
  await laptop.setViewport({ width: 1280, height: 900 });
  laptop.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  await laptop.goto(`${SITE}/try?api=${encodeURIComponent(`${API}/v1`)}`, { waitUntil: "networkidle2" });
  const t0 = Date.now();
  await (await laptop.waitForSelector("text/Connect my camera"))!.click();
  await laptop.waitForSelector("#demo-link", { timeout: 15_000 });
  const captureUrl = await laptop.$eval("#demo-link", (e) => (e as HTMLInputElement).value);
  results.qr_shown = (await laptop.$$eval("[role=img] svg", (s) => s.length)) > 0;
  results.session_created_ms = Date.now() - t0;
  const ticket = new URLSearchParams(new URL(captureUrl).hash.slice(1));
  const session = await db.query("select * from demo_sessions where source_id is not null order by created_at desc limit 1");
  const { id: sessionId, account_id: accountId, source_id: sourceId } = session.rows[0];
  log("demo started", { sessionId, captureUrl: captureUrl.split("#")[0], api: ticket.get("a") });

  // Phone: open the link from the QR code.
  const phoneCtx = await browser.createBrowserContext();
  const phone = await phoneCtx.newPage();
  await phone.emulate(KnownDevices["iPhone 13"]);
  phone.on("console", (m) => m.type() === "error" && consoleErrors.push(`phone: ${m.text()}`));
  const tScan = Date.now();
  await phone.goto(captureUrl, { waitUntil: "domcontentloaded" });
  await waitText(phone, "SENSEPLANE IS WATCHING", 30_000);
  results.phone_streaming_ms = Date.now() - tScan;
  await waitText(laptop, "Your agent can see now", 30_000);
  results.laptop_live_ms = Date.now() - tScan;
  log("camera live", results);

  await laptop.waitForSelector('img[alt="Latest view from your phone camera"]', { timeout: 30_000 });
  results.snapshot_shown = true;
  // Events: the person (and the package watch once the courier has gone).
  await waitText(laptop, "Heads up:", 120_000);
  results.first_event_ms = Date.now() - tScan;
  const watchHit = await waitText(laptop, /Heads up: [^\n]*(package|parcel|box)/i, 150_000).then(() => true, () => false);
  results.watch_event_ms = watchHit ? Date.now() - tScan : null;
  results.events = (await db.query("select type, summary, confidence from events where source_id = $1 order by occurred_at", [sourceId])).rows;
  log("events", { events: results.events });

  // Ask: live (a model looks at the current frame) and from memory.
  const ask = async (q: string) => {
    await laptop.$eval("#demo-ask", (e) => ((e as HTMLInputElement).value = ""));
    await laptop.type("#demo-ask", q);
    const before = await text(laptop, "body");
    const t = Date.now();
    await laptop.focus("#demo-ask");
    await laptop.keyboard.press("Enter");
    await waitText(laptop, `you › ${q}`, 60_000);
    void before;
    const answer = await laptop.$$eval(".sp-panel.sp-in span", (s) => (s.at(-1) as HTMLElement | undefined)?.innerText ?? "");
    return { q, answer, ms: Date.now() - t };
  };
  results.ask_live = await ask("What do you see right now?");
  results.ask_memory = await ask("When did the courier come?");
  log("asked", { live: results.ask_live, memory: results.ask_memory });
  results.vlm_calls = Number((await db.query("select coalesce(sum(quantity),0) n from usage_records where account_id = $1 and kind = 'vlm_calls'", [accountId])).rows[0].n);
  results.model_cost_usd = Number((await db.query("select coalesce(sum(quantity),0) n from usage_records where account_id = $1 and kind = 'model_cost_micro_usd'", [accountId])).rows[0].n) / 1e6;

  // End the demo from the laptop: the phone is disconnected.
  await laptop.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Start over")!.click());
  await waitText(phone, "The demo has ended", 15_000);
  results.phone_disconnected_on_end = true;
  await phoneCtx.close();

  // Deletion: pretend the hour has passed; the sweeper (every 30 s) deletes it all.
  const before = await s3.send(new ListObjectsV2Command({ Bucket: "senseplane", Prefix: `raw/${accountId}/` }));
  results.raw_objects_before = before.KeyCount ?? 0;
  await db.query("update demo_sessions set purge_after = now() where id = $1", [sessionId]);
  const deadline = Date.now() + 70_000;
  while (Date.now() < deadline && !(await db.query("select purged_at from demo_sessions where id = $1", [sessionId])).rows[0]?.purged_at) await new Promise((r) => setTimeout(r, 2000));
  const left = await Promise.all(["raw", "clips", "snapshots"].map((p) => s3.send(new ListObjectsV2Command({ Bucket: "senseplane", Prefix: `${p}/${accountId}/` })).then((r) => r.KeyCount ?? 0)));
  const rows = (await db.query("select (select count(*) from accounts where id = $1) a, (select count(*) from events where account_id = $1) e, (select count(*) from sources where account_id = $1) s", [accountId])).rows[0];
  results.deleted = { objects_left: left.reduce((a, b) => a + b, 0), accounts: Number(rows.a), events: Number(rows.e), sources: Number(rows.s) };
  results.console_errors = consoleErrors.filter((e) => !/favicon|Failed to load resource.*404/.test(e)).slice(0, 5);

  const pass = results.qr_shown && results.laptop_live_ms && results.first_event_ms && watchHit
    && (results.ask_live as { answer: string }).answer.length > 0 && (results.ask_memory as { answer: string }).answer.length > 0
    && results.phone_disconnected_on_end && (results.deleted as { objects_left: number; accounts: number }).objects_left === 0 && (results.deleted as { accounts: number }).accounts === 0;
  log(pass ? "PASS" : "FAIL", results);
  process.exitCode = pass ? 0 : 1;
} finally {
  await browser.close();
  await db.end();
}
