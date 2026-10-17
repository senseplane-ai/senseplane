// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Unit and component tests (jsdom + Testing Library). The Playwright e2e under
// e2e/ runs separately against a live stack (`pnpm e2e`).
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    css: false,
    testTimeout: 20_000,
  },
});
