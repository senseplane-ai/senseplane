// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vitest/config";

// Explicit and hermetic: only src tests, no network, generous timeouts so a
// loaded CI box (media tests run ffmpeg and mediasoup in parallel) can't flake it.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], pool: "threads", testTimeout: 20_000, hookTimeout: 20_000 },
});
