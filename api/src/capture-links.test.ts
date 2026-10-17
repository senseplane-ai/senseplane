// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Capture links are bound to the first device, expire
// before first use, and rotate.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

describe("capture links (ADR 0038)", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let key: string;
  let acc: string;

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, captureUrl: "https://console.test/capture.html", workers: false,
      media: { control: fakeMediaPlane().client },
    });
    acc = (await api.data.accounts.create("Links")).id;
    key = (await api.data.withAccount(acc, (s) => s.apiKeys.create("t"))).key;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  const call = (method: "GET" | "POST", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const ticketOf = (captureUrl: string) => new URLSearchParams(new URL(captureUrl).hash.slice(1)).get("t")!;
  const join = (ticket: string, device?: string) => api.public.inject({ method: "POST", url: "/v1/capture/join", payload: { ticket, ...(device ? { device } : {}) } });
  const phone = "phone-key-0123456789abcdef";
  const thief = "other-key-0123456789abcdef";

  it("binds to the first device; another device can't take over", async () => {
    const src = (await call("POST", "/v1/sources", { name: "Door", type: "browser" })).json();
    const t = ticketOf(src.ingest.capture_url);
    expect((await join(t, phone)).statusCode).toBe(200);
    expect((await join(t, phone)).statusCode).toBe(200); // the same phone reconnects
    const stolen = await join(t, thief);
    expect(stolen.statusCode).toBe(401);
    expect(stolen.json().error.message).toMatch(/another device/);
    expect((await join(t)).statusCode).toBe(401); // no device key once bound
  });

  it("rotating the link invalidates the old one and unbinds the device", async () => {
    const src = (await call("POST", "/v1/sources", { name: "Garden", type: "browser" })).json();
    const old = ticketOf(src.ingest.capture_url);
    expect((await join(old, phone)).statusCode).toBe(200);
    const rotated = await call("POST", `/v1/sources/${src.id}/capture-link`);
    expect(rotated.statusCode).toBe(201);
    expect((await join(old, phone)).statusCode).toBe(401);
    expect((await join(ticketOf(rotated.json().ingest.capture_url), thief)).statusCode).toBe(200); // a new device may bind the new link
    // Rotation is owner-only and audited.
    const audit = (await call("GET", "/v1/audit?limit=50")).json().data.map((e: { action: string }) => e.action);
    expect(audit).toContain("POST /v1/sources/:id/capture-link");
  });

  it("keeps senses in step with record_audio", async () => {
    const src = (await call("POST", "/v1/sources", { name: "Hall", type: "browser" })).json();
    expect(src.senses).toEqual(["video"]);
    const on = await api.public.inject({ method: "PATCH", url: `/v1/sources/${src.id}`, payload: { record_audio: true }, headers: { authorization: `Bearer ${key}` } });
    expect(on.json().senses).toEqual(["video", "audio"]);
    const off = await api.public.inject({ method: "PATCH", url: `/v1/sources/${src.id}`, payload: { record_audio: false }, headers: { authorization: `Bearer ${key}` } });
    expect(off.json().senses).toEqual(["video"]);
  });

  it("an unbound link must be used within 10 minutes of issue", async () => {
    vi.useFakeTimers({ now: Date.now() - 11 * 60_000, toFake: ["Date"] });
    const src = (await call("POST", "/v1/sources", { name: "Shed", type: "browser" })).json();
    vi.useRealTimers();
    const late = await join(ticketOf(src.ingest.capture_url), phone);
    expect(late.statusCode).toBe(401);
    expect(late.json().error.message).toMatch(/before first use/);
  });
});
