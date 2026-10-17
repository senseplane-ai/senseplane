// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The m5 check: a real MCP client (the official TypeScript SDK client) calls all 8
// tools against a running stack, over stdio (an API key made for code) and over
// remote HTTP after the full OAuth flow as a person sees it (ADR 0048):
// register → authorize → the console's consent page in a real browser → sign
// in → pick cameras, sensors and permissions → Allow → code + PKCE → token.
// Cancel sends access_denied back; reconnecting reuses the app. A camera with
// audio replays the crying-baby fixture and then the doorstep fixture; a
// sensor source gets readings.
//
// Run by `pnpm e2e` (which starts the stack, the console with VITE_MCP_URL set
// to the stack's MCP server, and Chrome). Alone:
//   E2E_API_URL=… E2E_MCP_URL=… E2E_CONSOLE_URL=… node m5-check.ts   (needs mcp/ built)
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type Browser, type Page, chromium } from "playwright-core";
import { devReplay } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const MCP = (process.env.E2E_MCP_URL ?? "http://localhost:58060").replace(/\/+$/, "");
const CONSOLE = process.env.E2E_CONSOLE_URL ?? "http://localhost:5173";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const MCP_DIST = new URL("../mcp/dist/", import.meta.url).pathname;
const SHOTS = join(process.env.E2E_ARTIFACTS ?? new URL("./.artifacts/", import.meta.url).pathname, "screenshots");
const REDIRECT = "http://127.0.0.1:53682/callback";
const CLIENT = "m5-check";
const PW = "correct horse battery staple";
mkdirSync(SHOTS, { recursive: true });
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A person signs up (open sign-up on the e2e stack); their session sets the stack up.
const email = `mcp-${Date.now().toString(36)}@example.test`;
const signup = await fetch(`${API}/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PW }) });
if (!signup.ok) throw new Error(`sign-up: ${signup.status} ${await signup.text()}`);
const { session, account_id: account } = await signup.json();
const call = async (method: string, path: string, body?: unknown, key = session) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const replay = devReplay(session);

// Sources: a camera with audio, and a climate sensor with an hour of readings.
const cam = await call("POST", "/v1/sources", { name: "Front door", location: "Door", type: "browser", record_audio: true });
const sensor = await call("POST", "/v1/sources", { name: "Kitchen sensor", location: "Kitchen", type: "sensor" });
const t = Date.now();
await call("POST", `/v1/sources/${sensor.id}/readings`, { readings: [0, 20, 40, 58].flatMap((m) => [
  { sense: "temperature", value: 20.5 + m / 30, unit: "celsius", measured_at: new Date(t - (60 - m) * 60_000).toISOString() },
  { sense: "humidity", value: 48, unit: "percent", measured_at: new Date(t - (60 - m) * 60_000).toISOString() },
]) });
// stdio takes an API key made for code (Agents → For developers), with grants on both sources.
const script = await call("POST", "/v1/agents", { name: "m5 stdio script" });
await call("POST", "/v1/grants", { agent_id: script.id, source_ids: [cam.id], senses: ["video", "audio"] });
await call("POST", "/v1/grants", { agent_id: script.id, source_ids: [sensor.id], senses: ["temperature", "humidity"] });
await replay("/dev/replay", { account_id: account, source_id: cam.id, file: `${FIXTURES}baby-crying-audio-640x360.mp4` });
log("replaying", { source: cam.id });
await sleep(4000);

const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail: unknown = {}) => {
  checks.push({ name, ok, detail });
  log(name, { ok, detail });
  return ok;
};

/** Registers like an MCP client and starts authorizing; returns where the browser is sent. */
async function startOAuth() {
  const unauth = await fetch(`${MCP}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  const metaUrl = unauth.headers.get("www-authenticate")!.match(/resource_metadata="([^"]+)"/)![1]!;
  const resource = await (await fetch(metaUrl)).json();
  const as = await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: CLIENT, redirect_uris: [REDIRECT] }) })).json();
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(8).toString("hex");
  const q = { client_id: reg.client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state };
  const auth = await fetch(`${as.authorization_endpoint}?${new URLSearchParams(q)}`, { redirect: "manual" });
  const consent = auth.headers.get("location") ?? "";
  check("authorize_sends_to_console_consent", auth.status === 302 && consent.startsWith(`${CONSOLE}/connect#request=`), { status: auth.status, to: consent.split("#")[0] });
  return { as, reg, verifier, state, consent };
}

/** Opens the consent page in the browser and resolves with the URL the MCP service redirects to. */
async function consentInBrowser(page: Page, url: string, act: (page: Page) => Promise<void>): Promise<URL> {
  let back: string | undefined;
  await page.route(`${new URL(REDIRECT).origin}/**`, (route) => {
    back = route.request().url();
    return route.fulfill({ status: 200, contentType: "text/html", body: "<p>You can close this tab.</p>" });
  });
  await page.goto(url);
  await act(page);
  for (let i = 0; i < 100 && !back; i++) await sleep(100);
  await page.unroute(`${new URL(REDIRECT).origin}/**`);
  if (!back) throw new Error("the MCP service never redirected back to the client");
  return new URL(back);
}

async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `${name}-1440.png`), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.screenshot({ path: join(SHOTS, `${name}-390.png`), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  check(`no_sideways_scroll_${name}`, overflow <= 1, { overflow });
}

let browser: Browser | undefined;
async function remoteToken(): Promise<string> {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

  // 1. Allow: sign in on the consent page, pick sources and permissions, Allow.
  const a = await startOAuth();
  const page = await ctx.newPage();
  const back = await consentInBrowser(page, a.consent, async (p) => {
    await p.getByRole("heading", { name: `Sign in to connect ${CLIENT}` }).waitFor({ timeout: 20_000 });
    check("consent_warns_unverified_host", await p.getByText(/This app is not verified/).isVisible() && await p.getByText("127.0.0.1:53682").first().isVisible());
    check("no_api_key_on_consent_or_sign_in", !(await p.getByText(/API key/i).count()) && !(await p.getByPlaceholder("sk_…").count()));
    await shoot(p, "m5-01-consent-sign-in");
    await p.getByLabel("Work email").fill(email);
    await p.getByLabel("Password").fill(PW);
    await p.getByRole("button", { name: "Sign in" }).click();
    await p.getByRole("heading", { name: `${CLIENT} wants to use your cameras` }).waitFor({ timeout: 20_000 });
    // Default: every source, everything but Listen. The agent here needs to listen too.
    const all = p.getByRole("button", { name: "All cameras and sensors" });
    check("consent_picks_all_sources_by_default", (await all.getAttribute("aria-pressed")) === "true");
    check("consent_listen_off_by_default", (await p.getByRole("button", { name: "Listen" }).getAttribute("aria-pressed")) === "false");
    await p.getByRole("button", { name: "Listen" }).click();
    await shoot(p, "m5-02-consent-pick");
    await p.getByRole("button", { name: "Allow" }).click();
  });
  check("allow_redirects_with_code_and_state", !!back.searchParams.get("code") && back.searchParams.get("state") === a.state, { error: back.searchParams.get("error") });
  const tok = await (await fetch(a.as.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", code_verifier: a.verifier, client_id: a.reg.client_id, redirect_uri: REDIRECT }) })).json();
  check("token_exchanged_with_pkce", !!tok.access_token, { error: tok.error });

  // The app is an agent named after the client, with the picked access.
  const apps = (await call("GET", "/v1/agents")).data.filter((x: any) => x.kind === "app" && x.name === CLIENT);
  const grants = (await call("GET", "/v1/grants")).data.filter((g: any) => g.agent_id === apps[0]?.id);
  check("app_agent_created_with_picked_access", apps.length === 1 && grants.length === 1
    && [...grants[0].source_ids].sort().join() === [cam.id, sensor.id].sort().join()
    && ["video", "audio", "temperature", "humidity"].every((s) => grants[0].senses.includes(s)) && grants[0].abilities.includes("watch"), { apps: apps.length, grant: grants[0] });

  // The first tab goes back to the console, still signed in (its session survives the round trip).
  await page.goto(CONSOLE);
  check("console_tab_still_signed_in", await page.getByLabel("Ask your cameras").waitFor({ timeout: 20_000 }).then(() => true, () => false));

  // 2. Cancel: the client gets access_denied and no code. The new tab borrows the open console tab's session: no sign-in.
  const d = await startOAuth();
  const second = await ctx.newPage();
  const denied = await consentInBrowser(second, d.consent, async (p) => {
    await p.getByRole("heading", { name: `${CLIENT} wants to use your cameras` }).waitFor({ timeout: 20_000 });
    check("consent_reuses_open_console_session", !(await p.getByLabel("Work email").count()));
    await p.getByRole("button", { name: "Cancel" }).click();
  });
  check("cancel_sends_access_denied", denied.searchParams.get("error") === "access_denied" && !denied.searchParams.get("code") && denied.searchParams.get("state") === d.state);

  // 3. Reconnect: the same app is reused (no second agent).
  const r = await startOAuth();
  const third = await ctx.newPage();
  const again = await consentInBrowser(third, r.consent, async (p) => {
    await p.getByText(/is already connected/).waitFor({ timeout: 20_000 });
    await p.getByRole("button", { name: "Allow" }).click();
  });
  const after = (await call("GET", "/v1/agents")).data.filter((x: any) => x.kind === "app" && x.name === CLIENT);
  check("reconnect_reuses_the_app", !!again.searchParams.get("code") && after.length === 1 && after[0].id === apps[0]?.id, { apps: after.length });
  await browser.close();
  browser = undefined;
  return tok.access_token;
}

type Result = { tool: string; ok: boolean; ms: number; summary: string };
async function exercise(client: Client, label: string): Promise<Result[]> {
  const results: Result[] = [];
  const run = async (tool: string, args: Record<string, unknown>, check: (r: any, body: any) => string | false) => {
    const t0 = Date.now();
    const r: any = await client.callTool({ name: tool, arguments: args });
    const textPart = r.content.find((c: any) => c.type === "text")?.text ?? "{}";
    const body = JSON.parse(textPart);
    const summary = r.isError ? `error ${textPart}` : check(r, body);
    results.push({ tool, ok: !r.isError && summary !== false, ms: Date.now() - t0, summary: String(summary).slice(0, 220) });
    return body;
  };
  const listed = (await client.listTools()).tools.map((x) => x.name);
  log(`${label}: tools`, { listed });
  await run("list_senses", {}, (_r, b) => b.sources.length === 2 && b.sources.map((s: any) => `${s.name}: ${s.senses.join("+")}`).join("; "));
  await run("listen", { source: "Front door", seconds: 8 }, (_r, b) => b.sounds.length > 0 && b.sounds.map((s: any) => `${s.sounds.join(",")} ${s.confidence}`).join("; "));
  await run("look", { source: "Front door" }, (r, b) => r.content[0]?.type === "image" && `image ${Math.round(r.content[0].data.length * 0.75 / 1024)} KB at ${b.captured_at}`);
  await run("read_environment", { room: "kitchen" }, (_r, b) => b.sources[0].readings.map((x: any) => `${x.sense} ${x.value} ${x.trend_last_hour}`).join("; "));
  const w = await run("watch_for", { condition: "Tell me if a package is left at the door", sources: ["Front door"], duration_minutes: 30 }, (_r, b) => !!b.watch_id && `${b.watch_id} ${b.compiled?.trigger?.type} expires ${b.expires_at}`);
  await run("what_happened", { question: "Did a baby cry?" }, (_r, b) => b.events.length > 0 && `${b.events[0].type}: ${b.events[0].summary}`);
  const from = new Date(Date.now() - 60_000).toISOString();
  await run("replay", { source: "Front door", from, to: new Date().toISOString(), save: label === "remote" }, (_r, b) => !!b.url && `${b.url.slice(0, 60)}…${b.clip_id ? ` clip ${b.clip_id}` : ""}`);
  await run("stop_watching", { watch_id: w.watch_id }, (_r, b) => b.stopped === w.watch_id && "stopped");
  return results;
}

let pass = true;
try {
  // 1. stdio, as Claude Desktop / Cursor / Claude Code would run it locally.
  const stdio = new Client({ name: "m5-check-stdio", version: "1" });
  await stdio.connect(new StdioClientTransport({ command: "node", args: [`${MCP_DIST}stdio.js`], env: { ...process.env, SENSEPLANE_API_KEY: script.api_key, SENSEPLANE_API_URL: `${API}/v1` } as Record<string, string> }));
  const a = await exercise(stdio, "stdio");
  await stdio.close();
  log("stdio", { results: a });

  // 2. remote HTTP with OAuth, consented in the browser.
  const token = await remoteToken();
  const remote = new Client({ name: "m5-check-remote", version: "1" });
  await remote.connect(new StreamableHTTPClientTransport(new URL(`${MCP}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const b = await exercise(remote, "remote");
  // Then switch the replay to the doorstep clip so look with a question has something to see.
  await replay("/dev/replay/stop", { source_id: cam.id });
  await replay("/dev/replay", { account_id: account, source_id: cam.id, file: `${FIXTURES}doorstep-delivery-reversed-640x360.mp4` });
  await sleep(9000);

  const asked: any = await remote.callTool({ name: "look", arguments: { source: "Front door", question: "Is anyone in the picture?" } });
  b.push({ tool: "look (question)", ok: !asked.isError, ms: 0, summary: asked.content.find((c: any) => c.type === "text").text.slice(0, 220) });
  await remote.close();
  log("remote", { results: b });
  pass = [...a, ...b].every((r) => r.ok) && checks.every((c) => c.ok);
} catch (err) {
  log("m5 error", { error: (err as Error).message.split("\n")[0] });
  pass = false;
} finally {
  await browser?.close();
  await replay("/dev/replay/stop", { source_id: cam.id });
}
log(pass ? "PASS" : "FAIL", { failed: checks.filter((c) => !c.ok).map((c) => c.name) });
process.exitCode = pass ? 0 : 1;
