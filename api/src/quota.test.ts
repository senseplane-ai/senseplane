// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { defaultQuota } from "./createApi.js";

describe("the instance's default quota", () => {
  it("has no caps unless the environment sets them", () => {
    expect(defaultQuota({})).toMatchObject({ maxSources: null, maxActiveSources: null, usageLimits: undefined, maxRetentionDays: null, liveView: true });
  });

  it("turns QUOTA_MAX_AI_CHECKS_PER_DAY into a hard daily AI-checks limit", () => {
    expect(defaultQuota({ QUOTA_MAX_AI_CHECKS_PER_DAY: "300" }).usageLimits).toEqual([
      { meter: "ai_checks", period: "day", limit: 300, enforcement: "hard" },
    ]);
  });
});
