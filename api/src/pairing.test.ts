// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Pairing a box with a code (ADR 0061).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { normalizeCode, newUserCode } from "./routes/pairing.js";
import { createTestDatabase } from "./testdb.js";

describe("pairing a bridge with a code", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let owner: string;
  let other: string;
  const call = (method: "GET" | "POST", url: string, payload?: unknown, key?: string) =>
    api.public.inject({ method, url, payload: payload as object, headers: key ? { authorization: `Bearer ${key}` } : {} });

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, workers: false, auth: { consoleUrls: ["https://console.test"] } as never });
    const acc = (await api.data.accounts.create("Home")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    const acc2 = (await api.data.accounts.create("Elsewhere")).id;
    other = (await api.data.withAccount(acc2, (s) => s.apiKeys.create("owner"))).key;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("makes readable codes and reads them back however they're typed", () => {
    for (let i = 0; i < 50; i++) expect(newUserCode()).toMatch(/^[BCDFGHJKMNPQRSTVWXZ2-9]{4}-[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/);
    expect(normalizeCode("bcdf ghjk")).toBe("BCDF-GHJK");
    expect(normalizeCode("BCDF-GHJ")).toBeUndefined();
    expect(normalizeCode("BCDF-GHJ0")).toBeUndefined(); // no zero in codes
  });

  it("pairs: the box asks, a person approves, the box collects its token once and works", async () => {
    const start = await call("POST", "/v1/bridge/pair", { name: "Home Assistant Green" });
    expect(start.statusCode).toBe(201);
    const p = start.json();
    expect(p).toMatchObject({ device_code: expect.stringMatching(/^brgp_/), user_code: expect.stringMatching(/^\w{4}-\w{4}$/), interval: 5, expires_in: 900,
      verification_url: "https://console.test/link", verification_url_complete: `https://console.test/link?code=${p.user_code}` });
    expect((await call("POST", "/v1/bridge/pair/token", { device_code: p.device_code })).json()).toEqual({ status: "waiting", interval: 5 });
    // The console finds the box by its code, typed loosely.
    const found = await call("GET", `/v1/bridges/pair?code=${p.user_code.toLowerCase().replace("-", " ")}`, undefined, owner);
    expect(found.json()).toMatchObject({ code: p.user_code, name: "Home Assistant Green" });
    expect((await call("GET", "/v1/bridges/pair?code=BBBB-BBBB", undefined, owner)).statusCode).toBe(404);
    // Approving needs a workspace key; the bridge belongs to that workspace.
    expect((await call("POST", "/v1/bridges/pair", { code: p.user_code })).statusCode).toBe(401);
    const ok = await call("POST", "/v1/bridges/pair", { code: p.user_code, name: "Mum's box" }, owner);
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ id: expect.stringMatching(/^brg_/), name: "Mum's box" });
    expect(ok.json().token).toBeUndefined(); // the person never sees the token
    // A second approval of the same code finds nothing.
    expect((await call("POST", "/v1/bridges/pair", { code: p.user_code }, other)).statusCode).toBe(404);

    const got = (await call("POST", "/v1/bridge/pair/token", { device_code: p.device_code })).json();
    expect(got).toMatchObject({ status: "approved", bridge_id: ok.json().id, token: expect.stringMatching(/^brg_/) });
    expect((await call("POST", "/v1/bridge/pair/token", { device_code: p.device_code })).statusCode).toBe(409); // once
    expect((await call("GET", "/v1/bridge/config", undefined, got.token)).json()).toMatchObject({ bridge_id: ok.json().id, name: "Mum's box" });
    expect((await call("GET", "/v1/bridges", undefined, owner)).json().data.map((b: { id: string }) => b.id)).toEqual([ok.json().id]);
    expect((await call("GET", "/v1/bridges", undefined, other)).json().data).toEqual([]);
    expect((await call("POST", "/v1/bridge/pair/token", { device_code: "brgp_nothing-like-this" })).statusCode).toBe(404);
  });
});
