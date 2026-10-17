// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Console e2e: sign up, add a camera, open it, ask a question, and open live
// view unlocked and locked. Screenshots at 1440 and 390 px land in
// e2e/screenshots/ (git-ignored).
//   pnpm --filter @senseplane/console e2e            # fake API in the page
//   E2E_LIVE=1 DEV_API_URL=http://localhost:36080 pnpm --filter @senseplane/console e2e
//     (a compose stack with AUTH_SIGNUP=open; endpoints it lacks are mocked)
import { type Page, expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { type FakeState, installFakeApi, seed } from "./fake-api";

const LIVE = process.env.E2E_LIVE === "1";
const shots = fileURLToPath(new URL("./screenshots/", import.meta.url));

async function shoot(page: Page, name: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.screenshot({ path: `${shots}${name}-1440.png`, fullPage: true });
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  // No sideways scroll at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: `${shots}${name}-390.png`, fullPage: true });
  await page.setViewportSize(size);
}

/** In live mode, overrides only the account limits (for the locked state). */
async function limitsOverride(page: Page, liveView: boolean) {
  await page.route("**/api/v1/account", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, limits: { ...(body.limits ?? {}), live_view: liveView } } });
  });
}

test("sign up, add a camera, open it, ask, and use live view", async ({ page }) => {
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && console.log(`console error: ${m.text()}`));
  let fake: FakeState | undefined;
  if (!LIVE) fake = await installFakeApi(page);
  const email = `e2e-${Date.now()}@example.com`;

  // Sign in page, then sign up like a person.
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("Lawful use")).toBeVisible();
  await shoot(page, "signin");
  await page.getByRole("button", { name: "Create an account" }).click();
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel(/^Password/).fill("correct horse battery staple");
  await page.getByRole("button", { name: "Create account" }).click();

  // Ask, empty state.
  await expect(page.getByRole("heading", { name: "What do you want to know?" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Console" })).toBeVisible();

  // Add a phone camera.
  await page.getByRole("link", { name: "Cameras" }).first().click();
  await expect(page.getByRole("heading", { name: "No cameras yet" })).toBeVisible();
  await page.getByRole("link", { name: "Add camera" }).first().click();
  await expect(page.getByRole("heading", { name: "What are you connecting?" })).toBeVisible();
  await shoot(page, "add-camera-choose");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Front door");
  await page.getByLabel("Where is it?").fill("Hallway");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Scan to connect" })).toBeVisible();
  await expect(page.getByRole("img", { name: "QR code for the capture link" }).locator("img")).toHaveAttribute("src", /^data:image\/png/);
  await expect(page.getByTestId("capture-link")).toHaveAttribute("href", /capture\.html#/);
  if (!LIVE) await expect(page.getByText("Connected. Front door is streaming.")).toBeVisible({ timeout: 10_000 });
  await shoot(page, "add-camera-connect");
  await page.getByRole("button", { name: "Open camera" }).click();

  // Camera detail.
  await expect(page.getByRole("heading", { level: 1, name: "Front door" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("slider")).toBeVisible();
  const cameraUrl = page.url();
  expect(cameraUrl).toMatch(/\/cameras\/src_/);
  if (fake) seed(fake);
  // Deep links work on a full reload (dev server falls back to index.html).
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Front door" })).toBeVisible();
  await page.getByRole("tab", { name: "Settings" }).click();
  await expect(page.getByRole("switch", { name: "Record audio" })).toBeVisible();
  await page.getByRole("tab", { name: "Events" }).click();
  await shoot(page, "camera");

  // Cameras list.
  await page.getByRole("link", { name: /^Cameras/ }).first().click();
  await expect(page.getByRole("link", { name: /Front door/ }).first()).toBeVisible();
  await shoot(page, "cameras");

  // Ask a question.
  await page.getByRole("link", { name: "Ask", exact: true }).click();
  await shoot(page, "ask-empty");
  await page.getByLabel("Ask your cameras").fill("When did the courier come today?");
  await page.keyboard.press("Enter");
  if (LIVE) {
    // A stack without the conversations API shows an alert instead of an answer.
    await expect(page.getByRole("alert").or(page.getByRole("article", { name: "Answer" }))).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(page.getByRole("button", { name: "Start watching" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Parcel left on the mat/ })).toBeVisible();
    await expect(page).toHaveURL(/\/chats\/cnv_/);
    await shoot(page, "ask-chat");
  }

  // Live view, unlocked.
  await page.getByRole("link", { name: "Live view" }).click();
  await expect(page.getByText("LIVE VIEW", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Open Front door large/ })).toBeVisible();
  await shoot(page, "live");
  await page.getByRole("button", { name: /Open Front door large/ }).click();
  await expect(page.getByRole("link", { name: "Rewind 1 minute" })).toHaveAttribute("href", /\/cameras\/src_.*\?t=/);
  await shoot(page, "live-focus");

  // Live view, locked.
  if (fake) fake.liveView = false;
  else await limitsOverride(page, false);
  await page.reload();
  await expect(page.getByRole("heading", { name: /Live view isn't included/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Replay recordings" })).toBeVisible();
  await shoot(page, "live-locked");

  // Sign out.
  await page.getByRole("button", { name: "Sign out" }).first().click({ force: true });
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("connect an MCP app on the consent page, then manage it under Agents", async ({ page }) => {
  test.skip(LIVE, "the consent flow against a real stack is e2e/m5-check.ts");
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  const fake = await installFakeApi(page);
  seed(fake);
  // The MCP service, as the console sees it (no VITE_MCP_URL: /mcp next to the API, so this origin).
  const decided: { url: string; body: string }[] = [];
  await page.route((u) => u.pathname === "/oauth/request", (route) => route.fulfill({
    contentType: "application/json", headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ client_name: "Claude Code", redirect_host: "127.0.0.1:33418", verified: false, binding: "b".repeat(43), expires_at: new Date(Date.now() + 900_000).toISOString() }),
  }));
  await page.route((u) => u.pathname === "/oauth/approve" || u.pathname === "/oauth/deny", (route) => {
    decided.push({ url: route.request().url(), body: route.request().postData() ?? "" });
    return route.fulfill({ contentType: "text/html", body: "<p>Back to the app.</p>" });
  });

  // Signed out: the consent page names the app and asks to sign in, without any key field.
  await page.goto("/connect#request=sealed_e2e");
  await expect(page.getByRole("heading", { name: "Sign in to connect Claude Code" })).toBeVisible();
  await expect(page.getByText(/This app is not verified/)).toBeVisible();
  await expect(page.getByText(/API key/i)).toHaveCount(0);
  await shoot(page, "consent-sign-in");
  await page.getByLabel("Work email").fill("alex@northwind.example");
  await page.getByLabel("Password").fill("correct horse battery staple");
  await page.getByRole("button", { name: "Sign in" }).click();

  // Pick sources and permissions, then Allow.
  await expect(page.getByRole("heading", { name: "Claude Code wants to use your cameras" })).toBeVisible();
  await page.getByRole("button", { name: "Server room" }).click();
  await page.getByRole("button", { name: "Listen" }).click();
  await shoot(page, "consent-pick");
  await page.getByRole("button", { name: "Allow" }).click();
  await expect.poll(() => decided.length).toBe(1);
  expect(decided[0]!.url).toMatch(/\/oauth\/approve$/);
  expect(decided[0]!.body).toContain("code=cc_e2e");

  // The console opens normally afterwards (the request is forgotten), and Agents lists the app.
  await page.goto("/agents");
  const app = page.getByRole("listitem", { name: "Claude Code" });
  await expect(app).toBeVisible();
  await expect(app).toContainText("Listen");
  await expect(app).not.toContainText("Server room");
  await shoot(page, "agents-apps");
  await app.getByRole("button", { name: "Edit access for Claude Code" }).click();
  await expect(app.getByRole("button", { name: "Save access" })).toBeVisible();
  await shoot(page, "agents-edit");
  await app.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Disconnect Claude Code" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("heading", { name: "No apps connected yet" })).toBeVisible();
  await shoot(page, "agents-empty");
});
