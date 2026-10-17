// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Live view end-to-end check (ADR 0042) against the compose stack, with
// headless Chrome on both sides:
//   1. a fake camera streams through the capture page (the phone path),
//      with audio (the source records audio);
//   2. viewers open console/live-test.html (openLive from console/src/live/client.ts):
//      - an account key with audio: frames within 2 s and an audio track;
//      - an agent key with only a video grant: frames within 2 s and no audio
//        track (and asking for audio is refused with forbidden_sense);
//   3. viewers with no user activity are closed after LIVE_IDLE_TIMEOUT_SECONDS,
//      a viewer with activity is not;
//   4. viewer-minutes show up in GET /v1/usage and the start is in the audit log.
// Prereqs: the stack up with LIVE_IDLE_TIMEOUT_SECONDS short (e.g. 20) and
// LIVE_SWEEP_SECONDS=3; the console's Vite dev server (live-test.html is dev-only)
// with CAPTURE_URL / CONSOLE_ORIGIN pointing at it.
import { execFileSync } from "node:child_process";
import puppeteer, { type Page } from "puppeteer-core";
import { compose } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const CONSOLE = process.env.E2E_CONSOLE_URL ?? "http://localhost:5173";
const IDLE_SECONDS = Number(process.env.LIVE_IDLE_TIMEOUT_SECONDS ?? 20);
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { api_key: ownerKey } = JSON.parse(
  execFileSync("docker", [...compose, "exec", "-T", "api", "node", "dist/cli.js", "create-account", "Live E2E"]).toString().trim().split("\n").pop()!,
);
const call = async (method: string, path: string, body?: unknown, key = ownerKey) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
};

const source = (await call("POST", "/v1/sources", { name: "Live E2E camera", type: "browser", record_audio: true })).json;
const agent = (await call("POST", "/v1/agents", { name: "Video-only viewer" })).json;
await call("POST", "/v1/grants", { agent_id: agent.id, source_ids: [source.id], senses: ["video"] });
log("source and agent created", { source: source.id, agent: agent.id });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
});
const checks: Record<string, unknown> = {};
let pass = true;
const expect = (name: string, ok: boolean, detail?: unknown) => {
  checks[name] = detail === undefined ? ok : { ok, ...((typeof detail === "object" && detail) || { value: detail }) };
  if (!ok) pass = false;
  log(ok ? "ok" : "FAILED", { check: name, detail });
};

try {
  // 1. The camera.
  const camera = await browser.newPage();
  camera.on("console", (m) => m.type() === "error" && !m.location().url?.includes("favicon") && log("capture page error", { text: m.text(), url: m.location().url }));
  await camera.goto(source.ingest.capture_url);
  await camera.waitForFunction("window.__senseplaneCapture && window.__senseplaneCapture.state() === 'live'", { timeout: 20_000 });
  for (let i = 0; i < 40 && (await call("GET", `/v1/sources/${source.id}`)).json.status !== "online"; i++) await sleep(500);
  log("camera live");

  // 2. Viewers.
  const viewer = async (key: string, audio: boolean) => {
    const page = await browser.newPage();
    page.on("console", (m) => m.type() === "error" && !m.location().url?.includes("favicon") && log("viewer page error", { text: m.text(), url: m.location().url }));
    const hash = new URLSearchParams({ a: `${API}/v1`, k: key, s: source.id, ...(audio ? { audio: "1" } : {}) });
    await page.goto(`${CONSOLE}/live-test.html#${hash}`);
    await page.waitForFunction("window.__liveTest && (window.__liveTest.firstFrameMs !== undefined || window.__liveTest.phase === 'error')", { timeout: 15_000 });
    return page;
  };
  const state = (page: Page) => page.evaluate(() => {
    const s = (window as unknown as { __liveTest: { phase: string; firstFrameMs?: number; frames: number; error?: string; closedReason?: string; tracks(): { video: number; audio: number } } }).__liveTest;
    return { phase: s.phase, firstFrameMs: s.firstFrameMs, frames: s.frames, error: s.error, closedReason: s.closedReason, tracks: s.tracks() };
  });
  const latency = (page: Page) => page.evaluate(async () => (await (window as unknown as { __liveTest: { view: { stats(): Promise<{ latencyMs?: number }> } } }).__liveTest.view.stats()).latencyMs);

  const owner = await viewer(ownerKey, true);
  const o = await state(owner);
  expect("owner viewer: first frame within 2 s", o.firstFrameMs !== undefined && o.firstFrameMs <= 2000, { firstFrameMs: o.firstFrameMs });
  expect("owner viewer with audio: has an audio track", o.tracks.audio === 1 && o.tracks.video === 1, o.tracks);

  const refused = await call("POST", `/v1/sources/${source.id}/live`, { audio: true }, agent.api_key);
  expect("video-only grant asking for audio: 403 forbidden_sense", refused.status === 403 && refused.json.error?.code === "forbidden_sense", { status: refused.status });

  const agentView = await viewer(agent.api_key, false);
  const a = await state(agentView);
  expect("video-only viewer: first frame within 2 s", a.firstFrameMs !== undefined && a.firstFrameMs <= 2000, { firstFrameMs: a.firstFrameMs });
  expect("video-only viewer: no audio track", a.tracks.audio === 0 && a.tracks.video === 1, a.tracks);
  await sleep(2000);
  const a2 = await state(agentView);
  expect("video-only viewer: frames keep arriving", a2.frames > a.frames + 20, { frames: a2.frames });
  log("latency estimate", { ownerMs: await latency(owner), agentMs: await latency(agentView) });

  // 3. Idle close: the two viewers above get no activity; this one does.
  const active = await viewer(ownerKey, false);
  const started = Date.now();
  while (Date.now() - started < (IDLE_SECONDS + 12) * 1000) {
    await active.mouse.move(10 + Math.random() * 100, 10 + Math.random() * 100);
    await sleep(2000);
    if ((await state(owner)).phase === "closed" && (await state(agentView)).phase === "closed" && Date.now() - started > IDLE_SECONDS * 1000) break;
  }
  const [oc, ac, act] = [await state(owner), await state(agentView), await state(active)];
  expect("idle viewers are closed with reason idle", oc.closedReason === "idle" && ac.closedReason === "idle", { owner: oc.closedReason, agent: ac.closedReason });
  expect("an active viewer stays open past the idle timeout", act.phase === "live" && act.frames > 0, { phase: act.phase });
  await active.evaluate(() => (window as unknown as { __liveTest: { view: { close(): void } } }).__liveTest.view.close());

  // 4. Metering and audit.
  let usage: { live_view_minutes?: number; live_view_minutes_by_source?: Record<string, number> } = {};
  for (let i = 0; i < 30; i++) {
    usage = (await call("GET", "/v1/usage")).json;
    if ((usage.live_view_minutes ?? 0) > 0.5) break;
    await sleep(1000);
  }
  expect("viewer-minutes are metered per source", (usage.live_view_minutes_by_source?.[source.id] ?? 0) > 0.5, { live_view_minutes: usage.live_view_minutes });
  const audit = (await call("GET", "/v1/audit")).json.data as { action: string; target: string; actor: string }[];
  expect("starting to watch is audited", audit.filter((e) => e.action === "live.start" && e.target === source.id).length >= 3);
  const acct = (await call("GET", "/v1/account")).json;
  expect("account limits: self-host default", acct.limits?.live_view === true && acct.limits?.max_live_viewers === null, acct.limits);

  await camera.bringToFront();
  await camera.click("#stop");
} finally {
  await browser.close();
}
console.log(JSON.stringify({ checks, pass }, null, 2));
process.exit(pass ? 0 : 1);
