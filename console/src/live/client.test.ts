// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from "vitest";
import { LiveError, openLive } from "./client";

afterEach(() => vi.unstubAllGlobals());

const video = {} as HTMLVideoElement;

it("asks the API for a viewer token, with or without /v1 in the base URL", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ error: { code: "conflict", message: "Front door isn't streaming right now" } }), { status: 409 });
  });
  await expect(openLive({ apiUrl: "https://api.test/v1", apiKey: "sk_1", sourceId: "src 1", video })).rejects.toMatchObject({ code: "conflict", status: 409 });
  await expect(openLive({ apiUrl: "https://api.test/", apiKey: "sk_1", sourceId: "src_2", video, audio: true })).rejects.toBeInstanceOf(LiveError);
  expect(calls.map((c) => c.url)).toEqual(["https://api.test/v1/sources/src%201/live", "https://api.test/v1/sources/src_2/live"]);
  expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer sk_1" });
  expect(calls.map((c) => JSON.parse(String(c.init.body)))).toEqual([{ audio: false }, { audio: true }]);
});

it("surfaces the quota provider's codes so the page can show the locked or limit state", async () => {
  for (const [status, code] of [[403, "feature_not_available"], [429, "limit_reached"]] as const) {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code, message: "x" } }), { status }));
    await expect(openLive({ apiUrl: "/api/v1", apiKey: "k", sourceId: "s", video })).rejects.toMatchObject({ code, status });
  }
});
