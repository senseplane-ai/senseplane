// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The m2 check: playback end to end against the compose stack: the recording timeline of a
// long-running source has no gaps, and random minutes start playing in a real
// browser (hls.js in headless Chrome) in under 2 s.
//   SOAK_KEY=sk_... SOAK_SOURCE=src_... node m2-check.ts [samples]
// Prereqs: compose --profile app, and the console preview pointed at it:
//   DEV_API_URL=http://localhost:58080 DEV_MEDIA_URL=http://localhost:58090 pnpm --filter @senseplane/console exec vite preview --port 5173
import puppeteer from "puppeteer-core";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const CONSOLE = process.env.E2E_CONSOLE_URL ?? "http://localhost:5173";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const KEY = process.env.SOAK_KEY!;
const SOURCE = process.env.SOAK_SOURCE!;
const SAMPLES = Number(process.argv[2] ?? 10);
const get = async (path: string) => {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${KEY}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const tl = await get(`/v1/sources/${SOURCE}/timeline`);
const first = Date.parse(tl.recorded[0].from);
const last = Date.parse(tl.recorded.at(-1).to);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const starts: number[] = [];
for (let i = 0; i < SAMPLES; i++) {
  const from = first + Math.random() * Math.max(0, last - first - 120_000);
  const t0 = Date.now();
  const { url } = await get(`/v1/sources/${SOURCE}/playback?from=${new Date(from).toISOString()}&to=${new Date(from + 60_000).toISOString()}`);
  const page = await browser.newPage();
  await page.goto(`${CONSOLE}/play.html#u=${encodeURIComponent(url)}`);
  await page.waitForFunction("window.__playStartedMs !== undefined", { timeout: 15_000 });
  starts.push(Date.now() - t0); // API call + page load + playlist + init + first segment + first frame
  await page.close();
}
// Console screens: Playback (timeline + player) and Clips, driven like a user.
const ui = await browser.newPage();
await ui.goto(CONSOLE);
await ui.evaluate((k) => sessionStorage.setItem("senseplane.apiKey", k), KEY);
await ui.reload();
await ui.waitForSelector("li button");
const buttons = await ui.$$("li button");
for (const b of buttons) if ((await b.evaluate((el) => el.textContent)) === "Playback") { await b.click(); break; }
await ui.waitForSelector(".track .rec", { timeout: 15_000 });
const recSpans = await ui.$$eval(".track .rec", (els) => els.length);
const clickByText = async (text: string) => {
  for (const b of await ui.$$("button")) if ((await b.evaluate((el) => el.textContent)) === text) return b.click();
  throw new Error(`no button ${text}`);
};
await clickByText("Last 5 min");
await clickByText("Play");
await ui.waitForFunction("document.querySelector('[data-testid=player]')?.currentTime > 0.5", { timeout: 15_000 });
await ui.type("input[aria-label='Clip title']", "e2e clip");
await clickByText("Save as clip");
await ui.waitForFunction("[...document.querySelectorAll('#clips-title ~ ul li strong')].some((e) => e.textContent === 'e2e clip')", { timeout: 15_000 });
const consoleOk = { timelineSpans: recSpans, playedInConsole: true, clipSavedInConsole: true };
await ui.close();
await browser.close();
starts.sort((a, b) => a - b);

const result = {
  recordedSpanMinutes: Number(((last - first) / 60_000).toFixed(1)),
  recordedRanges: tl.recorded.length,
  gaps: tl.gaps,
  playbackStartMs: { samples: SAMPLES, median: starts[Math.floor(SAMPLES / 2)], max: starts.at(-1) },
  console: consoleOk,
  pass: tl.gaps.length === 0 && starts.at(-1)! < 2000,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
