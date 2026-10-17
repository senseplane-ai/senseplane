// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The console journey, in a real browser against a real stack (run by
// `pnpm e2e`, which starts the stack and the console dev server):
//   sign up → invite a teammate, who accepts → add a phone camera (a fake
//   camera playing the doorstep fixture) and an IP camera through the bridge
//   → both online → ask a question and get a cited answer → a watch on both
//   cameras sending to one webhook and one agent → the doorstep fixture fires
//   it, and only that webhook and that agent get it → an MCP client connects
//   through the consent page (reusing the signed-in tab), shows up under
//   Agents and is disconnected there → live view works, and is
//   locked when the deployment turns it off (QUOTA_LIVE_VIEW=0) → save a clip,
//   search history and open a result → usage and the audit log show it all.
// Screenshots of each step at 1440 and 390 px wide go to $E2E_ARTIFACTS/screenshots.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page, chromium } from "playwright-core";
import { compose, project } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const MCP = (process.env.E2E_MCP_URL ?? "http://localhost:58060").replace(/\/+$/, "");
const CONSOLE = process.env.E2E_CONSOLE_URL ?? "http://localhost:5173";
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FAKE_VIDEO = process.env.E2E_FAKE_VIDEO;
const HOOK_HOST = process.env.E2E_HOOK_HOST ?? "host.docker.internal";
const BRIDGE_IMAGE = process.env.E2E_BRIDGE_IMAGE ?? "senseplane/bridge:dev";
const GO2RTC_IMAGE = process.env.E2E_GO2RTC_IMAGE ?? "alexxit/go2rtc:1.9.14";
const SHOTS = join(process.env.E2E_ARTIFACTS ?? new URL("./.artifacts/", import.meta.url).pathname, "screenshots");
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const RTSP_NAME = `${project}-journey-rtsp`;
const BRIDGE_NAME = `${project}-journey-bridge`;
const run = Date.now().toString(36);
const PW = "correct horse battery staple";
mkdirSync(SHOTS, { recursive: true });

const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = {}) => {
  if (!ok) failures.push(name);
  log(name, { ok, detail });
  return ok;
};
async function until<T>(what: string, ms: number, fn: () => Promise<T | undefined | false>): Promise<T | undefined> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(1000);
  }
  log(`timed out: ${what}`);
  return undefined;
}
const api = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as any };
};

// --- webhook receivers on this machine --------------------------------------------
type Hit = { type: string; watch_id?: string; source_id?: string };
async function receiver() {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      try {
        const e = JSON.parse(b);
        hits.push({ type: e.type, watch_id: e.watch_id ?? e.data?.watch_id, source_id: e.source?.id ?? e.source_id });
      } catch {
        /* not JSON */
      }
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
  const port = (server.address() as { port: number }).port;
  return { hits, url: `http://${HOOK_HOST}:${port}/hook`, close: () => server.close() };
}

// --- browser helpers --------------------------------------------------------------
async function shoot(page: Page, name: string) {
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  await page.screenshot({ path: join(SHOTS, `${name}-1440.png`), fullPage: true });
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await page.screenshot({ path: join(SHOTS, `${name}-390.png`), fullPage: true });
  await page.setViewportSize(size);
  if (overflow > 1) check(`no_sideways_scroll_${name}`, false, { overflow });
}
async function go(page: Page, path: string) {
  await page.evaluate((p) => {
    history.pushState(null, "", p);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await sleep(300);
}

const cleanup = () => {
  for (const n of [BRIDGE_NAME, RTSP_NAME]) {
    try {
      docker("rm", "-f", n);
    } catch {
      /* not running */
    }
  }
};

let browser: Browser | undefined;
let phone: Browser | undefined;
const hookA = await receiver();
const hookB = await receiver();
cleanup();
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const owner = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await owner.newPage();
  page.on("pageerror", (e) => log("page error", { message: e.message }));

  // 1. Sign up.
  await page.goto(CONSOLE);
  await page.getByRole("button", { name: "Create an account" }).click();
  const email = `owner-${run}@example.test`;
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PW);
  await shoot(page, "01-sign-up");
  await page.getByRole("button", { name: "Create account" }).click();
  const signedUp = await page.getByLabel("Ask your cameras").waitFor({ timeout: 20_000 }).then(() => true, () => false);
  check("signed_up_and_on_ask", signedUp);
  const key = await page.evaluate(() => sessionStorage.getItem("senseplane.apiKey") ?? "");
  check("console_session", key.startsWith("sk_"), {});
  await shoot(page, "02-ask-empty");

  // 2. Invite a teammate; they accept in their own browser and sign up.
  await go(page, "/settings");
  await page.getByRole("tab", { name: "Team" }).click();
  await page.getByRole("button", { name: "Invite someone" }).click();
  const mate = `teammate-${run}@example.test`;
  await page.getByLabel("Email").fill(mate);
  await page.getByRole("button", { name: "Create invite link" }).click();
  const link = (await page.locator(".adm-secret code").first().textContent({ timeout: 10_000 }))?.trim() ?? "";
  check("invite_link_created", link.includes("#invite=inv_"), { link: link.replace(/inv_[A-Za-z0-9_-]+/, "inv_<redacted>") });
  await shoot(page, "03-invite");
  await page.getByRole("button", { name: "Done" }).click();
  const mateCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const matePage = await mateCtx.newPage();
  await matePage.goto(link);
  await matePage.getByRole("heading", { name: /^Join / }).waitFor({ timeout: 15_000 });
  await matePage.getByLabel("Your name").fill("Sam Teammate");
  await matePage.getByLabel("Choose a password").fill(PW);
  await shoot(matePage, "04-accept-invite");
  await matePage.getByRole("button", { name: "Create account and join" }).click();
  const joined = await matePage.getByLabel("Ask your cameras").waitFor({ timeout: 20_000 }).then(() => true, () => false);
  const mateKey = await matePage.evaluate(() => sessionStorage.getItem("senseplane.apiKey") ?? "");
  const mateMe = (await api(mateKey, "GET", "/v1/me")).json;
  check("teammate_joined_as_member", joined && mateMe.role === "member", { role: mateMe.role });
  await mateCtx.close();

  // 3a. A phone camera: the capture link opened by a phone (a fake camera playing the doorstep fixture).
  await go(page, "/cameras/new");
  await page.getByRole("radio", { name: /Phone/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Front door");
  await page.getByRole("button", { name: "Continue" }).click();
  const captureUrl = await page.getByTestId("capture-link").getAttribute("href", { timeout: 15_000 });
  check("capture_link_shown", !!captureUrl?.includes("capture.html"), {});
  await shoot(page, "05-add-phone");
  phone = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", ...(FAKE_VIDEO ? [`--use-file-for-fake-video-capture=${FAKE_VIDEO}`] : [])],
  });
  const phonePage = await (await phone.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera", "microphone"] })).newPage();
  await phonePage.goto(captureUrl!);
  const streaming = await phonePage.waitForFunction("window.__senseplaneCapture && window.__senseplaneCapture.state() === 'live'", undefined, { timeout: 30_000 }).then(() => true, () => false);
  check("phone_streaming", streaming);
  const phoneConnected = await page.getByText(/Connected\. Front door is streaming\./).waitFor({ timeout: 30_000 }).then(() => true, () => false);
  check("add_camera_sees_it_connect", phoneConnected);
  await shoot(page, "06-phone-connected");
  const sources = async () => (await api(key, "GET", "/v1/sources")).json.data as { id: string; name: string; status: string }[];
  const front = (await sources()).find((s) => s.name === "Front door")!;

  // 3b. An IP camera through the bridge: go2rtc plays an RTSP camera; the bridge runs with the token the console shows.
  await go(page, "/cameras");
  await go(page, "/cameras/new");
  await page.getByRole("radio", { name: /IP camera/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Driveway");
  await page.getByRole("button", { name: "Continue" }).click();
  const bridgeToken = (await page.getByLabel("Bridge token", { exact: true }).textContent({ timeout: 15_000 }))?.trim() ?? "";
  const dockerCmd = (await page.getByLabel("Docker", { exact: true }).textContent())?.trim() ?? "";
  check("bridge_command_shown", bridgeToken.startsWith("brg_") && dockerCmd.includes("--token"), { docker: dockerCmd.replace(bridgeToken, "brg_<redacted>") });
  await shoot(page, "07-add-ip-camera");
  docker("run", "-d", "--name", RTSP_NAME, "--network", `${project}_default`, "--network-alias", "journey-camera",
    "-v", `${FIXTURES}:/fixtures:ro`, "--entrypoint", "go2rtc", GO2RTC_IMAGE, "-config",
    JSON.stringify({ api: { listen: "" }, webrtc: { listen: "" }, rtsp: { listen: ":8554" },
      streams: { cam: "exec:ffmpeg -hide_banner -v error -re -stream_loop -1 -i /fixtures/testsrc-h264-640x360-20s.mp4 -an -c copy -rtsp_transport tcp -f rtsp {output}" } }));
  await sleep(2000);
  const media = docker(...compose, "ps", "-q", "media").trim();
  docker("run", "-d", "--name", BRIDGE_NAME, "--network", `container:${media}`, BRIDGE_IMAGE,
    "--api", "http://api:8080", "--token", bridgeToken, "--rtsp", "rtsp://journey-camera:8554/cam", "--whip-base", "http://127.0.0.1:8090", "--listen", "127.0.0.1:8099");
  const ipConnected = await page.getByText(/Connected\. Driveway is streaming\./).waitFor({ timeout: 60_000 }).then(() => true, () => false);
  check("ip_camera_online", ipConnected);
  const drive = (await sources()).find((s) => s.name === "Driveway")!;
  await go(page, "/cameras");
  await page.getByText("Streaming").first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  const both = await until("both cameras online", 30_000, async () => (await sources()).filter((s) => s.status === "online").length === 2);
  check("both_cameras_online_in_cameras_list", !!both);
  await shoot(page, "08-cameras");

  // 4. Ask a question; the answer cites a moment.
  await sleep(20_000); // a few loops of the doorstep clip, so there is history to cite
  await go(page, "/");
  await page.getByLabel("Ask your cameras").fill("When did someone come to the front door?");
  await page.keyboard.press("Enter");
  const answer = page.getByRole("article", { name: "Answer" }).last();
  const cited = await answer.locator("a.moment").first().waitFor({ timeout: 90_000 }).then(() => true, () => false);
  const answerText = (await answer.locator(".answer-text").textContent().catch(() => "")) ?? "";
  check("cited_answer", cited && /\[\d+\]/.test(answerText), { answer: answerText.slice(0, 200) });
  await shoot(page, "09-ask");

  // 5. Two webhooks and two agents; the watch sends to webhook A and agent A only.
  await go(page, "/webhooks");
  for (const h of [hookA, hookB]) {
    await page.getByRole("button", { name: "Add endpoint" }).first().click();
    await page.getByLabel("URL").fill(h.url);
    await page.getByRole("dialog").getByRole("button", { name: "Add endpoint" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /Done|Close/ }).first().click().catch(() => undefined);
    await sleep(500);
  }
  await shoot(page, "10-webhooks");
  await go(page, "/agents");
  const agentKeys: Record<string, string> = {};
  for (const name of ["ops-bot", "other-bot"]) {
    await page.getByRole("button", { name: "Create API key" }).click();
    await page.getByRole("dialog").getByPlaceholder("ops-bot production").fill(name);
    await page.getByRole("dialog").getByRole("button", { name: "All cameras" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Create key" }).click();
    agentKeys[name] = ((await page.getByRole("dialog").locator(".adm-code code").textContent({ timeout: 10_000 })) ?? "").trim();
    await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  }
  check("agent_keys_created", Object.values(agentKeys).every((k) => k.startsWith("sk_")), { agents: Object.keys(agentKeys) });
  await shoot(page, "11-agents");

  // 5b. An MCP client connects (ADR 0048): its Connect opens the consent page in a new tab, which
  // reuses this tab's session; the owner keeps only Front door and allows. The app shows under
  // Agents with that access, and Disconnect cuts its token off.
  const appRedirect = "http://127.0.0.1:53683/callback";
  const reg = await (await fetch(`${MCP}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Journey MCP", redirect_uris: [appRedirect] }) })).json();
  const verifier = randomBytes(32).toString("base64url");
  const authorize = await fetch(`${MCP}/oauth/authorize?${new URLSearchParams({ client_id: reg.client_id, redirect_uri: appRedirect, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "j1" })}`, { redirect: "manual" });
  const consentPage = await owner.newPage();
  let appBack = "";
  await consentPage.route("http://127.0.0.1:53683/**", (r) => {
    appBack = r.request().url();
    return r.fulfill({ status: 200, contentType: "text/html", body: "<p>Connected. You can close this tab.</p>" });
  });
  await consentPage.goto(authorize.headers.get("location") ?? `${CONSOLE}/connect`);
  const asked = await consentPage.getByRole("heading", { name: "Journey MCP wants to use your cameras" }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
  check("consent_page_reuses_the_session", asked && !(await consentPage.getByLabel("Work email").count()));
  await consentPage.getByRole("button", { name: "Driveway", exact: true }).click();
  await shoot(consentPage, "11b-consent");
  await consentPage.getByRole("button", { name: "Allow" }).click();
  await until("the app's redirect", 20_000, async () => !!appBack);
  const appCode = appBack ? new URL(appBack).searchParams.get("code") ?? "" : "";
  const appToken = (await (await fetch(`${MCP}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: appCode, code_verifier: verifier, client_id: reg.client_id, redirect_uri: appRedirect }) })).json()).access_token as string | undefined;
  const mcpStatus = async () => (await fetch(`${MCP}/mcp`, { method: "POST", headers: { authorization: `Bearer ${appToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status;
  check("mcp_app_connected", !!appToken && (await mcpStatus()) === 200);
  await consentPage.close();
  await go(page, "/");
  await go(page, "/agents");
  const appCard = page.getByRole("listitem", { name: "Journey MCP" });
  const listed = await appCard.waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const cardText = listed ? ((await appCard.textContent()) ?? "") : "";
  check("app_listed_with_its_access", listed && cardText.includes("Front door") && !cardText.includes("Driveway"), { card: cardText.slice(0, 160) });
  await shoot(page, "11c-agents-apps");
  await page.getByRole("button", { name: "Disconnect Journey MCP" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  const cutOff = await until("the app's token stops working", 60_000, async () => (await mcpStatus()) === 401);
  check("disconnect_cuts_the_app_off", !!cutOff);
  await go(page, "/watches");
  await page.getByLabel("What should Senseplane watch for?").first().fill("Tell me when someone comes to the front door");
  await page.getByRole("button", { name: "Front door", exact: true }).first().click();
  await page.getByRole("button", { name: "Driveway", exact: true }).first().click();
  await page.getByRole("button", { name: new URL(hookA.url).host }).first().click();
  await page.getByRole("button", { name: /ops-bot/ }).first().click();
  await shoot(page, "12-watch-composer");
  await page.getByRole("button", { name: "Start watching" }).click();
  const watch = await until("the watch", 30_000, async () => {
    const list = (await api(key, "GET", "/v1/watches")).json.data as any[];
    return list.find((w) => w.instruction.includes("front door"));
  });
  const hooks = (await api(key, "GET", "/v1/webhooks")).json.data as { id: string; url: string }[];
  const agents = (await api(key, "GET", "/v1/agents")).json.data as { id: string; name: string }[];
  const dests = (list: { type: string; id?: string }[] = []) => list.map((d) => `${d.type}:${d.id}`).sort().join();
  const wantNotify = [{ type: "webhook", id: hooks.find((h) => h.url === hookA.url)?.id }, { type: "agent", id: agents.find((a) => a.name === "ops-bot")?.id }];
  check("watch_on_two_cameras_to_one_webhook_and_one_agent",
    !!watch && [...watch.sources].sort().join() === [front.id, drive.id].sort().join() && dests(watch.notify) === dests(wantNotify),
    { sources: watch?.sources, notify: watch?.notify });
  await shoot(page, "13-watches");

  // 6. The doorstep clip keeps looping on the phone: the watch fires; only webhook A and ops-bot get it.
  const fired = await until("watch.triggered at webhook A", 180_000, async () => hookA.hits.find((h) => h.type === "watch.triggered"));
  await sleep(5000);
  const inboxA = (await api(agentKeys["ops-bot"]!, "GET", "/v1/inbox")).json.data as any[] ?? [];
  const inboxB = (await api(agentKeys["other-bot"]!, "GET", "/v1/inbox")).json.data as any[] ?? [];
  check("webhook_a_got_the_watch", !!fired, { hits: hookA.hits.length });
  check("agent_a_inbox_has_it", inboxA.some((i) => (i.event?.watch_id ?? i.watch_id) === watch?.id), { items: inboxA.length });
  check("webhook_b_and_agent_b_did_not", !hookB.hits.some((h) => h.type === "watch.triggered") && !inboxB.length, { b_hits: hookB.hits.map((h) => h.type), b_inbox: inboxB.length });
  await go(page, "/events");
  await page.getByText(/Watch fired/).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  await shoot(page, "14-events");

  // 7. Live view, unlocked.
  await go(page, "/live");
  const live = await page.locator(".lv-badge").first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  check("live_view_streams", live);
  await shoot(page, "15-live");

  // 8. Save a clip on the camera page; search history; open a result.
  await go(page, `/cameras/${front.id}`);
  await page.getByRole("button", { name: "Save clip" }).click({ timeout: 30_000 });
  const saved = await page.getByText(/Clip saved/).waitFor({ timeout: 20_000 }).then(() => true, () => false);
  check("clip_saved", saved);
  await shoot(page, "16-camera");
  await go(page, "/search");
  await page.getByPlaceholder("person in a yellow jacket").fill("person at the door");
  await page.keyboard.press("Enter");
  const tile = page.locator("button.adm-tile").first();
  const found = await tile.waitFor({ timeout: 30_000 }).then(() => true, () => false);
  check("search_finds_history", found);
  await shoot(page, "17-search");
  if (found) {
    await tile.click();
    await page.waitForURL(/\/cameras\/src_[^?]+\?t=/, { timeout: 10_000 }).catch(() => undefined);
    check("search_result_opens_camera_at_time", /\/cameras\/src_[^?]+\?t=/.test(page.url()), { url: page.url().replace(CONSOLE, "") });
    await page.getByTestId("playhead-label").waitFor({ timeout: 15_000 }).catch(() => undefined);
    await shoot(page, "18-search-result");
  }
  await go(page, "/search");
  await page.getByRole("tab", { name: /Saved clips/ }).click();
  const clipListed = await page.getByRole("button", { name: /^Play / }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
  check("clip_listed", clipListed);
  await shoot(page, "19-clips");

  // 9. Usage and the audit log show the activity.
  await go(page, "/usage");
  await page.getByText(/Camera time|camera/i).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  const usage = (await api(key, "GET", "/v1/usage")).json;
  check("usage_shows_activity", usage.camera_minutes > 0 && usage.ai_checks > 0 && usage.live_view_minutes >= 0, { camera_minutes: usage.camera_minutes, ai_checks: usage.ai_checks, live_view_minutes: usage.live_view_minutes });
  await shoot(page, "20-usage");
  await go(page, "/settings");
  await page.getByRole("tab", { name: "Audit log" }).click();
  const audited = await page.locator("table tbody tr").nth(3).waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const actions = new Set<string>();
  for (let cursor = "", pages = 0; pages < 50; pages++) {
    const page = (await api(key, "GET", `/v1/audit?limit=100${cursor ? `&cursor=${cursor}` : ""}`)).json;
    for (const a of page.data as { action: string }[]) actions.add(a.action);
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  check("audit_log_shows_activity", audited && actions.has("invite.created") && actions.has("invite.accepted") && actions.has("live.start"), { actions: [...actions].filter((a) => !a.includes(" ")).slice(0, 20) });
  await shoot(page, "21-audit");

  // 10. Live view locked: the deployment turns it off (QUOTA_LIVE_VIEW=0), then back on.
  const restartApi = (on: boolean) =>
    execFileSync("docker", [...compose, "up", "-d", "--no-deps", "--wait", "api"], { env: { ...process.env, QUOTA_LIVE_VIEW: on ? "1" : "0" }, stdio: ["ignore", "pipe", "pipe"] });
  restartApi(false);
  await page.reload();
  await go(page, "/live");
  const locked = await page.getByRole("heading", { name: /Live view isn.t included/ }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const refused = await api(key, "POST", `/v1/sources/${front.id}/live`, {});
  check("live_view_locked_when_off", locked && refused.status === 403 && refused.json.error?.code === "feature_not_available", { status: refused.status });
  await shoot(page, "22-live-locked");
  restartApi(true);
} catch (err) {
  check("journey_ran", false, { error: (err as Error).message.split("\n")[0] });
} finally {
  await browser?.close();
  await phone?.close();
  hookA.close();
  hookB.close();
  cleanup();
}
log("done", { failures, screenshots: SHOTS });
process.exit(failures.length ? 1 : 0);
