// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Shared by the e2e checks: which compose stack they run against. `pnpm e2e`
// (run.ts) sets these for its own stack; run alone, a check uses the default
// `senseplane` project and files.
//   E2E_COMPOSE_PROJECT    compose project name
//   E2E_COMPOSE_FILES      comma-separated compose files (default deploy/compose/docker-compose.yml)
//   E2E_COMPOSE_ENV_FILES  comma-separated --env-file arguments
import { execFileSync } from "node:child_process";

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const DEFAULT_FILE = new URL("../deploy/compose/docker-compose.yml", import.meta.url).pathname;

/** `docker compose …` arguments for the stack under test, `--profile app` included. */
export const compose: string[] = [
  "compose",
  ...(process.env.E2E_COMPOSE_PROJECT ? ["-p", process.env.E2E_COMPOSE_PROJECT] : []),
  ...list(process.env.E2E_COMPOSE_ENV_FILES).flatMap((f) => ["--env-file", f]),
  ...(list(process.env.E2E_COMPOSE_FILES).length ? list(process.env.E2E_COMPOSE_FILES) : [DEFAULT_FILE]).flatMap((f) => ["-f", f]),
  "--profile", "app",
];

/** The compose project name (for container and network names). */
export const project = process.env.E2E_COMPOSE_PROJECT ?? "senseplane";

/** Creates an account with the admin CLI in the api container (or E2E_CREATE_ACCOUNT, a shell command). */
export function createAccount(name: string): { account_id: string; api_key: string } {
  const out = process.env.E2E_CREATE_ACCOUNT
    ? execFileSync("sh", ["-c", process.env.E2E_CREATE_ACCOUNT]).toString()
    : execFileSync("docker", [...compose, "exec", "-T", "api", "node", "dist/cli.js", "create-account", name]).toString();
  return JSON.parse(out.trim().split("\n").pop()!);
}

/** The capture page in headless Chrome, its fake camera (and microphone) playing a fixture. */
function chromeReplay(key: string, api: string) {
  const running = new Map<string, { close(abrupt: boolean): Promise<void> }>();
  const art = process.env.E2E_ARTIFACTS ?? new URL("./.artifacts/", import.meta.url).pathname;
  const ok = new Response(JSON.stringify({ started: true }), { status: 200 });
  return async (path: string, body: { source_id: string; file?: string; abrupt?: boolean }): Promise<Response> => {
    const id = body.source_id;
    if (path === "/dev/replay/stop") {
      await running.get(id)?.close(body.abrupt === true);
      running.delete(id);
      return new Response(JSON.stringify({ stopped: true }), { status: 200 });
    }
    const { existsSync, mkdirSync } = await import("node:fs");
    const { basename, join } = await import("node:path");
    mkdirSync(join(art, "replay"), { recursive: true });
    const file = body.file!;
    const y4m = join(art, "replay", `${basename(file)}.y4m`);
    const wav = join(art, "replay", `${basename(file)}.wav`);
    if (!existsSync(y4m)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", "fps=15", "-pix_fmt", "yuv420p", y4m]);
    let audio = existsSync(wav);
    if (!audio) {
      try {
        execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "48000", wav]);
        audio = true;
      } catch {
        audio = false; // no audio stream
      }
    }
    const link = await fetch(`${api}/v1/sources/${id}/capture-link`, { method: "POST", headers: { authorization: `Bearer ${key}` } });
    if (!link.ok) throw new Error(`capture link for ${id}: ${link.status}`);
    const url = ((await link.json()) as { ingest: { capture_url: string } }).ingest.capture_url;
    const { default: puppeteer } = await import("puppeteer-core");
    const browser = await puppeteer.launch({
      executablePath: process.env.E2E_CHROME ?? process.env.CHROME_PATH, headless: true,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`,
        ...(audio ? [`--use-file-for-fake-audio-capture=${wav}`] : []), "--autoplay-policy=no-user-gesture-required", "--no-sandbox"],
    });
    const page = await browser.newPage();
    const said: string[] = [];
    page.on("console", (m) => said.push(m.text().slice(0, 300)));
    await page.goto(url);
    try {
      await page.waitForFunction("window.__senseplaneCapture && window.__senseplaneCapture.state() === 'live'", { timeout: 30_000 });
    } catch (err) {
      const state = await page.evaluate("window.__senseplaneCapture && window.__senseplaneCapture.state()").catch(() => undefined);
      const text = await page.evaluate("document.getElementById('status')?.textContent ?? document.body.innerText").catch(() => "");
      await browser.close();
      throw new Error(`capture page for ${id} not live (state ${String(state)}): ${String(text).slice(0, 300)} | console: ${said.slice(-5).join(" / ")}`, { cause: err });
    }
    await running.get(id)?.close(true);
    running.set(id, {
      async close(abrupt) {
        if (!abrupt) await page.click("#stop").catch(() => undefined);
        await browser.close();
      },
    });
    return ok;
  };
}

/**
 * The dev replay publisher (MEDIA_DEV_REPLAY=1) through the real path: the
 * account's key gets the camera a fresh capture link, the capture join makes
 * the API ensure the camera's room and feed and mint a join token, and the
 * media plane plays the file as that participant (spec/media, ADR 0050).
 * Returns `replay(path, body)`: `/dev/replay` with
 * `{ source_id, file }`, `/dev/replay/stop` with `{ source_id, abrupt? }`.
 */
export function devReplay(key: string, api = process.env.E2E_API_URL ?? "http://localhost:38080", media = process.env.E2E_MEDIA_URL ?? "http://localhost:38090") {
  const post = (url: string, body: object, auth?: string) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
  // E2E_REPLAY=chrome: the real capture page in Chrome, its fake camera playing the file. Works on any
  // media plane (one without the open-source server's dev replay).
  if (process.env.E2E_REPLAY === "chrome") return chromeReplay(key, api);
  return async (path: string, body: { source_id: string; file?: string; abrupt?: boolean; account_id?: string }): Promise<Response> => {
    const id = body.source_id;
    if (path === "/dev/replay/stop") return post(`${media}/dev/replay/stop`, { room: `sp-${id}`, identity: `${id}:capture`, abrupt: body.abrupt === true });
    const link = await post(`${api}/v1/sources/${id}/capture-link`, {}, key);
    if (!link.ok) throw new Error(`capture link for ${id}: ${link.status} ${await link.text()}`);
    const ticket = ((await link.json()) as { ingest: { token: string } }).ingest.token;
    const join = await post(`${api}/v1/capture/join`, { ticket });
    if (!join.ok) throw new Error(`capture join for ${id}: ${join.status} ${await join.text()}`);
    const { token } = (await join.json()) as { token: string };
    return post(`${media}/dev/replay`, { token, file: body.file });
  };
}
