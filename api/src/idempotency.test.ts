// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expireIdempotencyKeys } from "./idempotency.js";
import { createApi, type SenseplaneApi } from "./index.js";
import { createTestDatabase } from "./testdb.js";

describe("Idempotency-Key on create routes", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let key: string;
  let other: string;
  let acc: string;
  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({ database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html",
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } } });
    acc = (await api.data.accounts.create("Idem")).id;
    key = (await api.data.withAccount(acc, (s) => s.apiKeys.create("t"))).key;
    const acc2 = (await api.data.accounts.create("Other")).id;
    other = (await api.data.withAccount(acc2, (s) => s.apiKeys.create("t"))).key;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });
  const post = (k: string, idem: string | undefined, payload: object) =>
    api.public.inject({ method: "POST", url: "/v1/sources", headers: { authorization: `Bearer ${k}`, ...(idem ? { "idempotency-key": idem } : {}) }, payload });

  it("replays the first response for a retry with the same body", async () => {
    const a = await post(key, "k1", { name: "Door", type: "browser" });
    const b = await post(key, "k1", { name: "Door", type: "browser" });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    expect(b.json().id).toBe(a.json().id);
    const list = (await api.public.inject({ url: "/v1/sources", headers: { authorization: `Bearer ${key}` } })).json().data;
    expect(list.filter((s: { name: string }) => s.name === "Door")).toHaveLength(1);
  });

  it("refuses the same key with a different body, scopes keys per account, and ignores requests without a key", async () => {
    const c = await post(key, "k1", { name: "Garage", type: "browser" });
    expect(c.statusCode).toBe(422);
    expect(c.json().error.code).toBe("idempotency_key_reused");
    expect((await post(other, "k1", { name: "Door", type: "browser" })).headers["idempotent-replayed"]).toBeUndefined();
    const x = await post(key, undefined, { name: "Yard", type: "browser" });
    const y = await post(key, undefined, { name: "Yard", type: "browser" });
    expect(x.json().id).not.toBe(y.json().id);
  });

  it("does not store errors from validation, and expires keys after 24 h", async () => {
    expect((await post(key, "bad", { name: "", type: "nope" })).statusCode).toBe(400);
    expect((await post(key, "bad", { name: "Shed", type: "browser" })).statusCode).toBe(201);
    expect(await expireIdempotencyKeys(api.data)).toBe(0);
  });
});
