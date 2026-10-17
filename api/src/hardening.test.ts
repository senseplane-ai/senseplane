// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { defaultCredentialProblems } from "./ingest.js";

describe("production refuses development credentials (ADR 0035)", () => {
  const prod = { SENSEPLANE_MODE: "production", API_PUBLIC_URL: "https://api.example.com" };

  it("flags the compose defaults", () => {
    const problems = defaultCredentialProblems({
      ...prod,
      DATABASE_URL: "postgres://senseplane_app:senseplane_app@postgres:5432/senseplane",
      S3_SECRET_ACCESS_KEY: "senseplane-secret",
      VALKEY_URL: "redis://valkey:6379",
      MEDIA_SIGNING_KEY: "dev-1:abc",
    });
    expect(problems.join("|")).toMatch(/DATABASE_URL/);
    expect(problems.join("|")).toMatch(/S3_SECRET_ACCESS_KEY/);
    expect(problems.join("|")).toMatch(/Valkey needs a password/);
    expect(problems.join("|")).toMatch(/MEDIA_SIGNING_KEY is the development key/);
    expect(defaultCredentialProblems({ ...prod, VALKEY_URL: "redis://:dev-valkey@valkey:6379" }).join("|")).toMatch(/development default/);
    expect(defaultCredentialProblems({ SENSEPLANE_MODE: "production" }).join("|")).toMatch(/API_PUBLIC_URL/);
  });

  it("accepts real secrets, and ignores development mode", () => {
    expect(defaultCredentialProblems({
      ...prod,
      DATABASE_URL: "postgres://senseplane_app:4f9c2a@postgres:5432/senseplane",
      S3_SECRET_ACCESS_KEY: "x".repeat(40),
      VALKEY_URL: "redis://:7d1e0b@valkey:6379",
      MEDIA_SIGNING_KEY: "prod-1:abc",
    })).toEqual([]);
    expect(defaultCredentialProblems({ DATABASE_URL: "postgres://senseplane_app:senseplane_app@x/y" })).toEqual([]);
  });
});
