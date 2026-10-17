// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "@playwright/test";

// Console end-to-end (ADR 0046). Starts the Vite dev server, which proxies
// /api to DEV_API_URL. With E2E_LIVE=1 the tests use that real API (a compose
// stack with AUTH_SIGNUP=open); otherwise they run against an in-page fake API
// (e2e/fake-api.ts), so they work without a stack.
const port = Number(process.env.E2E_PORT ?? 5186);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    // The installed Chrome, so no browser download is needed.
    channel: process.env.E2E_CHANNEL ?? "chrome",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `pnpm exec vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 60_000,
    env: { DEV_API_URL: process.env.DEV_API_URL ?? "http://localhost:36080", DEV_MEDIA_URL: process.env.DEV_MEDIA_URL ?? "http://localhost:36090" },
  },
});
