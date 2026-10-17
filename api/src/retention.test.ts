// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleBrainEvent } from "./brain-events.js";
import { handleMediaEvent } from "./indexer.js";
import { createApi, type SenseplaneApi, sweepOnce } from "./index.js";
import type { Quota } from "./module.js";
import type { ObjectStorage } from "./storage.js";
import { createTestDatabase } from "./testdb.js";

const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return log; }, level: "silent", silent() {} } as never;

function fakeStorage() {
  const objects = new Map<string, number>();
  const s: ObjectStorage & { objects: Map<string, number> } = {
    objects,
    async put(k, body) { objects.set(k, body.length); },
    async copy(a, b) { objects.set(b, objects.get(a) ?? 0); },
    async deleteMany(keys) { let n = 0; for (const k of keys) if (objects.delete(k)) n++; return n; },
    async deletePrefix(p) { let n = 0; for (const k of [...objects.keys()]) if (k.startsWith(p) && objects.delete(k)) n++; return n; },
    async presign() { return undefined; },
    async get() { throw new Error("not used"); },
  };
  return s;
}

describe("retention modes", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let key: string;
  let acc: string;
  const storage = fakeStorage();
  let quota: Quota = { maxSources: null, maxRetentionDays: null };
  const auth = () => ({ authorization: `Bearer ${key}` });
  const call = (method: "GET" | "PATCH" | "POST", url: string, payload?: object) => api.public.inject({ method, url, headers: auth(), ...(payload ? { payload } : {}) });
  const day = 86400_000;

  /** Records n segments of `bytes` each, one per hour, starting `startDaysAgo` days ago. */
  async function record(src: string, n: number, bytes: number, startDaysAgo: number) {
    for (let i = 0; i < n; i++) {
      const k = `raw/${acc}/${src}/${startDaysAgo}-${i}.m4s`;
      storage.objects.set(k, bytes);
      await handleMediaEvent(api.data, "media.segment.written", {
        account_id: acc, source_id: src, key: k, init_key: `raw/${acc}/${src}/init.mp4`,
        start: new Date(Date.now() - startDaysAgo * day + i * 3600_000).toISOString(), duration_ms: 6000, bytes, codec: "h264",
      }, log);
    }
  }
  const segs = (src: string) => api.data.withAccount(acc, (s) => s.db.selectFrom("segments").select(["key", "start_at"]).where("source_id", "=", src).orderBy("start_at").execute());

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, workers: false, captureUrl: "https://c/capture.html", storage, sweepIntervalSeconds: 0,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } },
      modules: [{ name: "q", quotaFor: async () => quota }],
    });
    acc = (await api.data.accounts.create("Retention")).id;
    key = (await api.data.withAccount(acc, (s) => s.apiKeys.create("t"))).key;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("refuses fill mode with no cap anywhere, and accepts it with the deployment's cap", async () => {
    const r = await call("PATCH", "/v1/account", { retention_mode: "fill" });
    expect(r.statusCode).toBe(400);
    quota = { ...quota, storageCapBytes: 1_000_000 };
    const ok = await call("PATCH", "/v1/account", { retention_mode: "fill" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ retention_mode: "fill", retention_max_bytes: null, storage: { storage_cap_bytes: 1_000_000 } });
    await call("PATCH", "/v1/account", { retention_mode: "days" });
    quota = { maxSources: null, maxRetentionDays: null };
  });

  it("keeps raw footage until deleted when days mode has no number of days", async () => {
    const src = (await call("POST", "/v1/sources", { name: "Forever", type: "browser" })).json().id;
    await record(src, 3, 1000, 400);
    expect((await call("PATCH", "/v1/account", { retention_days: null })).json().retention_days).toBeNull();
    await sweepOnce(api.data, storage);
    expect(await segs(src)).toHaveLength(3);
    await call("PATCH", "/v1/account", { retention_days: 7 });
    await sweepOnce(api.data, storage);
    expect(await segs(src)).toHaveLength(0);
  });

  it("fill mode deletes the oldest raw footage first, counts clips and snapshots against the cap, and never touches clips", async () => {
    const door = (await call("POST", "/v1/sources", { name: "Door", type: "browser" })).json().id;
    const yard = (await call("POST", "/v1/sources", { name: "Yard", type: "browser" })).json().id;
    await record(door, 6, 1000, 2);
    await record(yard, 4, 1000, 1);
    // A clip (1500 bytes, kept) and a snapshot (500 bytes) count against the account cap.
    await api.data.withAccount(acc, (s) => s.db.insertInto("clips").values({
      id: "clp_keep", account_id: acc, source_id: door, title: "Keep", from_at: new Date(), to_at: new Date(), duration_ms: 6000, bytes: 1500,
    } as never).execute());
    storage.objects.set(`clips/${acc}/clp_keep/0.m4s`, 1500);
    await handleBrainEvent(api.data, storage, "brain.event", {
      event_key: "snap1", account_id: acc, source_id: door, type: "detection.person", occurred_at: new Date().toISOString(),
      labels: ["person"], confidence: 0.9, summary: "Person.", snapshot_jpeg_b64: Buffer.alloc(500).toString("base64"),
    }, log);

    // Account cap 8000 − 2000 kept = 6000 bytes of raw across both sources (10 000 recorded).
    const r = await call("PATCH", "/v1/account", { retention_mode: "fill", retention_max_bytes: 8000 });
    expect(r.json().storage).toMatchObject({ raw_bytes: 10_000, clip_bytes: 1500, snapshot_bytes: 500 });
    const before = (await segs(door)).map((s) => s.key);
    await sweepOnce(api.data, storage);
    const doorLeft = (await segs(door)).map((s) => s.key);
    const yardLeft = await segs(yard);
    expect(doorLeft.length + yardLeft.length).toBe(6);
    expect(yardLeft).toHaveLength(4); // the yard's footage is newer
    expect(doorLeft).toEqual(before.slice(4)); // the four oldest went first
    expect(storage.objects.has(before[0]!)).toBe(false);
    expect(storage.objects.get(`clips/${acc}/clp_keep/0.m4s`)).toBe(1500);
    expect(await api.data.withAccount(acc, (s) => s.db.selectFrom("clips").select("id").execute())).toHaveLength(1);

    // A source with its own cap is capped alone.
    await call("PATCH", `/v1/sources/${yard}`, { retention_mode: "fill", retention_max_bytes: 1500 });
    await sweepOnce(api.data, storage);
    expect(await segs(yard)).toHaveLength(1);
    const acct = (await call("GET", "/v1/account")).json();
    expect(acct.storage.estimated_days).not.toBeNull();
    expect((await call("GET", `/v1/sources/${yard}`)).json()).toMatchObject({ retention_mode: "fill", retention_max_bytes: 1500 });
  });
});
