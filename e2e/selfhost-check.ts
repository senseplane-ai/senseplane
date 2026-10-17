// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Checks a running self-host stack (the root docker-compose.yml, docs/self-host-vm.md)
// from the outside, through Caddy only, in a real Chrome:
//   health of api, mcp and media → the first sign-up owns the workspace →
//   a second sign-up is refused → a phone camera (a fake camera playing the
//   doorstep fixture) streams and shows online → a detection.person event →
//   an MCP client connects through the consent page and lists its tools.
//
//   SELFHOST_URL=https://localhost node e2e/selfhost-check.ts
//
// It needs a fresh stack (nobody signed up yet). Caddy's own certificate is
// accepted for localhost. Screenshots go to e2e/.artifacts/selfhost/.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "playwright-core";

const BASE = (process.env.SELFHOST_URL ?? "https://localhost").replace(/\/+$/, "");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ART = new URL("./.artifacts/selfhost/", import.meta.url).pathname;
const FIXTURE = new URL("../fixtures/doorstep-parcel-640x360.mp4", import.meta.url).pathname;
const PW = "correct horse battery staple";
mkdirSync(ART, { recursive: true });
// Caddy's internal CA for localhost: trusted for this process only.
if (new URL(BASE).hostname === "localhost") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(JSON.stringify({ t: new Date().toISOString().slice(11, 19), check: name, ok, ...(detail === undefined ? {} : { detail }) }));
  return ok;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(ms: number, fn: () => Promise<T | undefined | false>): Promise<T | undefined> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(1000);
  }
  return undefined;
}
const json = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${BASE}${path}`, init);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};

// 1. Health, through Caddy.
for (const [name, path] of [["api", "/healthz"], ["mcp", "/healthz/mcp"], ["media", "/healthz/media"]] as const) {
  const r = await until(120_000, async () => {
    const x = await json(path);
    return x.status === 200 ? x : undefined;
  });
  check(`health_${name}`, !!r, r?.body);
}
const internal = await fetch(`${BASE}/api/internal/media/callbacks`, { method: "POST" });
check("internal_routes_not_public", internal.status === 404, { status: internal.status });
const providers = (await json("/api/auth/providers")).body;
check("signup_open_before_first_user", providers.signup === true && providers.mcp_url === BASE, providers);

// The fake camera plays the doorstep fixture (someone walks up to the door).
const y4m = join(ART, "doorstep.y4m");
if (!existsSync(y4m)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", FIXTURE, "-vf", "fps=15", "-pix_fmt", "yuv420p", y4m]);

let browser: Browser | undefined;
let phone: Browser | undefined;
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const owner = await browser.newContext({ viewport: { width: 1280, height: 860 }, ignoreHTTPSErrors: true });
  const page = await owner.newPage();
  page.on("pageerror", (e) => console.log(JSON.stringify({ pageerror: e.message })));

  // 2. The first sign-up owns the workspace.
  await page.goto(BASE);
  await page.getByRole("button", { name: "Create an account" }).click();
  await page.getByLabel("Work email").fill("owner@example.test");
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Create account" }).click();
  const signedUp = await page.getByLabel("Ask your cameras").waitFor({ timeout: 20_000 }).then(() => true, () => false);
  await page.screenshot({ path: join(ART, "01-signed-up.png") });
  const key = await page.evaluate(() => sessionStorage.getItem("senseplane.apiKey") ?? "");
  const auth = { authorization: `Bearer ${key}` };
  const me = (await json("/v1/me", { headers: auth })).body;
  check("first_signup_is_owner", signedUp && me.role === "owner", { role: me.role });

  // 3. Sign-up is closed now, in the API and in the console.
  const second = await json("/auth/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "second@example.test", password: PW }) });
  const other = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await other.goto(BASE);
  await other.getByRole("button", { name: /Sign in/ }).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  const offered = await other.getByRole("button", { name: "Create an account" }).count();
  await other.screenshot({ path: join(ART, "02-signup-closed.png") });
  check("second_signup_refused", second.status === 403 && second.body.error?.code === "signup_refused" && offered === 0, { status: second.status, create_button: offered });

  // 4. A phone camera: the console's capture link, opened by a browser with a fake camera.
  await page.evaluate(() => {
    history.pushState(null, "", "/cameras/new");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByRole("radio", { name: /Phone/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Front door");
  await page.getByRole("button", { name: "Continue" }).click();
  const captureUrl = (await page.getByTestId("capture-link").getAttribute("href", { timeout: 15_000 })) ?? "";
  check("capture_link_on_the_domain", captureUrl.startsWith(`${BASE}/capture.html#`) && captureUrl.includes(`a=${encodeURIComponent(BASE)}`));
  phone = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${y4m}`],
  });
  const phonePage = await (await phone.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera", "microphone"], ignoreHTTPSErrors: true })).newPage();
  await phonePage.goto(captureUrl);
  const live = await phonePage.waitForFunction("window.__senseplaneCapture && window.__senseplaneCapture.state() === 'live'", undefined, { timeout: 45_000 }).then(() => true, () => false);
  await phonePage.screenshot({ path: join(ART, "03-capture.png") });
  check("phone_streaming", live, live ? undefined : { status: await phonePage.locator("#status").textContent().catch(() => "") });
  const connected = await page.getByText(/Connected\. Front door is streaming\./).waitFor({ timeout: 30_000 }).then(() => true, () => false);
  await page.screenshot({ path: join(ART, "04-camera-connected.png") });
  const online = await until(30_000, async () => ((await json("/v1/sources", { headers: auth })).body.data as any[]).find((s) => s.name === "Front door" && s.status === "online"));
  check("camera_online", connected && !!online, { status: online?.status });

  // 5. Someone walks up to the door: a person detection.
  const person = await until(180_000, async () => ((await json("/v1/events?limit=50", { headers: auth })).body.data as any[] ?? []).find((e) => e.type === "detection.person"));
  check("detection_person_event", !!person, person ? { summary: person.summary, confidence: person.confidence } : undefined);
  const snapshot = person?.media?.snapshot_url as string | undefined;
  const snap = snapshot ? await fetch(snapshot) : undefined;
  check("event_snapshot_through_caddy", !!snapshot?.startsWith(BASE) && snap?.status === 200 && snap.headers.get("content-type") === "image/jpeg", { status: snap?.status });

  // 6. The recording plays back through the same origin (signed HLS from the API).
  const range = await until(60_000, async () => ((await json(`/v1/sources/${online?.id}/timeline`, { headers: auth })).body.recorded as any[] ?? [])[0]);
  const pb = range ? (await json(`/v1/sources/${online?.id}/playback?${new URLSearchParams({ from: range.from, to: range.to })}`, { headers: auth })).body : {};
  const playlist = pb.url ? await (await fetch(pb.url)).text() : "";
  const first = playlist.split("\n").find((l) => l && !l.startsWith("#"));
  const seg = first ? await fetch(new URL(first, pb.url)) : undefined;
  check("recording_plays_back", !!pb.url?.startsWith(`${BASE}/playback/`) && playlist.startsWith("#EXTM3U") && seg?.status === 200, { range, segment: seg?.status });

  // 7. An MCP client connects through the consent page on the same domain.
  const redirect = "http://127.0.0.1:53999/callback";
  const reg = (await json("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Self-host check", redirect_uris: [redirect] }) })).body;
  const meta = (await json("/.well-known/oauth-authorization-server")).body;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = await fetch(`${BASE}/oauth/authorize?${new URLSearchParams({ client_id: reg.client_id, redirect_uri: redirect, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "s1" })}`, { redirect: "manual" });
  const consentUrl = authorize.headers.get("location") ?? "";
  check("oauth_metadata_and_consent_on_the_domain", meta.issuer === BASE && consentUrl.startsWith(`${BASE}/connect`), { issuer: meta.issuer, consent: consentUrl.split("#")[0]?.split("?")[0] });
  const consent = await owner.newPage();
  let back = "";
  await consent.route("http://127.0.0.1:53999/**", (r) => {
    back = r.request().url();
    return r.fulfill({ status: 200, contentType: "text/html", body: "<p>ok</p>" });
  });
  await consent.goto(consentUrl);
  await consent.getByRole("heading", { name: /wants to use your cameras/ }).waitFor({ timeout: 20_000 }).catch(() => undefined);
  await consent.screenshot({ path: join(ART, "05-consent.png") });
  await consent.getByRole("button", { name: "Allow" }).click({ timeout: 10_000 }).catch(() => undefined);
  await until(20_000, async () => !!back);
  const code = back ? new URL(back).searchParams.get("code") ?? "" : "";
  const token = (await json("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect }) })).body.access_token as string | undefined;
  const tools = token ? await json("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }) : undefined;
  check("mcp_connected_through_consent", tools?.status === 200 && (tools.body.result?.tools?.length ?? 0) > 0, { status: tools?.status, tools: tools?.body.result?.tools?.length });
} catch (err) {
  check("no_unexpected_error", false, (err as Error).message.split("\n")[0]);
} finally {
  await phone?.close();
  await browser?.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nselfhost-check: ${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((f) => f.name).join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
