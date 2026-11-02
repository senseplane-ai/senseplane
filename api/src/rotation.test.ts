// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Key rotation (ADR 0066) against the compose object store (S3 on :59000):
// an account's key rotated while footage keeps playing, the old key deleted
// once everything moved, and a master key rotation re-wrapping every key.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { handleMediaEvent } from "./indexer.js";
import { createKeyRing, encryptSegment, envKeyWrapper, segmentIV, segmentKey } from "./keys.js";
import { SETTLE_MS, reencryptKeys, rewrapKeys } from "./rotation.js";
import { createObjectStorage, encryptingStorage, readObject, type StorageConfig } from "./storage.js";
import { createTestDatabase } from "./testdb.js";

const S3: StorageConfig = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://localhost:59000", region: "us-east-1", bucket: "senseplane",
  accessKeyId: "senseplane", secretAccessKey: "senseplane-secret", forcePathStyle: true,
};
const s3 = new S3Client({ endpoint: S3.endpoint, region: S3.region, forcePathStyle: true, credentials: { accessKeyId: S3.accessKeyId!, secretAccessKey: S3.secretAccessKey! } });
const raw = async (Key: string) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: "senseplane", Key }))).Body!.transformToByteArray());
const FIXTURE = new URL("../../fixtures/testsrc-h264-640x360-20s.mp4", import.meta.url).pathname;
const OLD_MASTER = "old-master-key-for-tests-".repeat(2);
const NEW_MASTER = "new-master-key-for-tests-".repeat(2);
const log = { warn() {}, error() {}, info() {} } as never;

async function playableSeconds(url: string): Promise<number> {
  const { stdout } = await promisify(execFile)("ffmpeg", ["-v", "error", "-allowed_extensions", "ALL", "-i", url, "-map", "0:v", "-f", "null", "-", "-progress", "pipe:1"], { encoding: "utf8", timeout: 60_000 });
  const t = [...stdout.matchAll(/out_time_ms=(\d+)/g)].at(-1);
  return t ? Number(t[1]) / 1e6 : 0;
}

describe("key rotation", () => {
  let api: SenseplaneApi;
  let t: Awaited<ReturnType<typeof createTestDatabase>>;
  let acc: string;
  let key: string;
  let src: string;
  let origin: string;
  let clipUrl: string;
  const segKeys: string[] = [];
  const base = Date.now() - 3600_000;
  const auth = () => ({ authorization: `Bearer ${key}` });
  const snap = () => `snapshots/${acc}/${src}/before.jpg`;
  const ringFor = (master: string, previous: string[] = []) => createKeyRing(api.data, envKeyWrapper(master, previous));

  beforeAll(async () => {
    t = await createTestDatabase();
    api = await createApi({
      database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", storage: S3, sweepIntervalSeconds: 0, workers: false,
      mediaEncryptionKey: OLD_MASTER, media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } },
    });
    origin = await api.public.listen({ port: 0, host: "127.0.0.1" });
    acc = (await api.data.accounts.create("Rotating")).id;
    key = (await api.data.withAccount(acc, (s) => s.apiKeys.create("t"))).key;
    src = (await api.public.inject({ method: "POST", url: "/v1/sources", headers: auth(), payload: { name: "Door", type: "browser" } })).json().id;
    const dk = await ringFor(OLD_MASTER).current(acc);
    const dir = mkdtempSync(join(tmpdir(), "sp-rot-"));
    execFileSync("ffmpeg", ["-v", "error", "-i", FIXTURE, "-t", "8", "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4",
      "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", join(dir, "seg_%03d.m4s"), "-hls_list_size", "0", join(dir, "index.m3u8")]);
    const durations = [...readFileSync(join(dir, "index.m3u8"), "utf8").matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
    const initKey = `raw/${acc}/${src}/init/a.mp4`;
    await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: initKey, Body: readFileSync(join(dir, "init.mp4")) }));
    let t0 = base;
    for (const [i, f] of readdirSync(dir).filter((x) => x.endsWith(".m4s")).sort().entries()) {
      const k = `raw/${acc}/${src}/x/${t0}.m4s`;
      const iv = segmentIV(dk.key, k);
      const sealed = encryptSegment(segmentKey(dk.key, src), iv, readFileSync(join(dir, f)));
      await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: k, Body: sealed }));
      await handleMediaEvent(api.data, "media.segment.written", {
        account_id: acc, source_id: src, key: k, init_key: initKey, start: new Date(t0).toISOString(), duration_ms: durations[i],
        bytes: sealed.length, codec: "h264", encryption: { method: "aes-128", key_id: String(dk.version), iv: iv.toString("hex") },
      }, log);
      segKeys.push(k);
      t0 += durations[i]!;
    }
    const clip = await api.public.inject({ method: "POST", url: "/v1/clips", headers: auth(), payload: { source: src, from: new Date(base).toISOString(), to: new Date(base + 4000).toISOString() } });
    clipUrl = origin + new URL(clip.json().playback_url).pathname;
    await encryptingStorage(createObjectStorage(S3), ringFor(OLD_MASTER)).put(snap(), Buffer.from("snapshot from before"), "image/jpeg");
  }, 60_000);
  afterAll(async () => {
    await api?.close();
    await t?.drop();
  });

  const playback = async () => {
    const range = `from=${new Date(base).toISOString()}&to=${new Date(base + 60_000).toISOString()}`;
    return origin + new URL((await api.public.inject({ url: `/v1/sources/${src}/playback?${range}`, headers: auth() })).json().url).pathname;
  };
  const deps = (master: string, previous: string[] = []) => {
    const wrapper = envKeyWrapper(master, previous);
    return { data: api.data, storage: createObjectStorage(S3), keys: createKeyRing(api.data, wrapper), wrapper };
  };

  it("rotates an account's key: new footage uses it at once, old footage is re-encrypted and keeps playing", async () => {
    const before = await raw(segKeys[0]!);
    const started = await api.public.inject({ method: "POST", url: "/v1/account/keys/rotate", headers: auth() });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ current_version: 2, rotating: true, segments_left: segKeys.length + 2 });
    expect((await ringFor(OLD_MASTER).current(acc)).version).toBe(2);
    // Mid-rotation, old footage still plays (its key version is still there).
    expect(await playableSeconds(await playback())).toBeGreaterThan(6);

    const run = await reencryptKeys(deps(OLD_MASTER), 30_000);
    expect(run).toMatchObject({ segments: segKeys.length, clipSegments: 2, objects: 1, retired: 0 }); // not settled yet
    expect((await raw(segKeys[0]!)).equals(before)).toBe(false);
    const rows = await api.data.withAccount(acc, (s) => s.db.selectFrom("segments").select("enc_version").execute());
    expect(rows.every((r) => r.enc_version === 2)).toBe(true);
    expect((await raw(snap())).readUInt32BE(4)).toBe(2);
    expect((await api.public.inject({ url: "/v1/account/keys", headers: auth() })).json()).toMatchObject({ current_version: 2, rotating: true, segments_left: 0 });
    expect(await playableSeconds(await playback())).toBeGreaterThan(6);
    expect(await playableSeconds(clipUrl)).toBeGreaterThan(2);

    // Settled: the old version is deleted; what was copied before can't be opened any more.
    const later = await reencryptKeys(deps(OLD_MASTER), 30_000, () => Date.now() + SETTLE_MS + 60_000);
    expect(later.retired).toBe(1);
    const left = await api.data.withAccount(acc, (s) => s.db.selectFrom("account_keys").select("version").execute());
    expect(left.map((r) => r.version)).toEqual([2]);
    expect(await ringFor(OLD_MASTER).get(acc, 1)).toBeUndefined();
    expect((await api.public.inject({ url: "/v1/account/keys", headers: auth() })).json()).toEqual({ current_version: 2, rotating: false });
    expect(await playableSeconds(await playback())).toBeGreaterThan(6);
    expect(await playableSeconds(clipUrl)).toBeGreaterThan(2);
    expect((await readObject(encryptingStorage(createObjectStorage(S3), ringFor(OLD_MASTER)), snap())).toString()).toBe("snapshot from before");
  });

  it("rotates the master key: every account key is wrapped again, and the new key alone opens them", async () => {
    await expect(ringFor(NEW_MASTER).current(acc)).rejects.toThrow();
    const moved = await rewrapKeys(deps(NEW_MASTER, [OLD_MASTER]));
    expect(moved).toBeGreaterThanOrEqual(1);
    expect(await rewrapKeys(deps(NEW_MASTER, [OLD_MASTER]))).toBe(0); // nothing left to move
    expect((await ringFor(NEW_MASTER).current(acc)).version).toBe(2);
    const store = encryptingStorage(createObjectStorage(S3), ringFor(NEW_MASTER));
    expect((await readObject(store, snap())).toString()).toBe("snapshot from before");
  });

  it("only the owner rotates; agents can't", async () => {
    const agent = (await api.public.inject({ method: "POST", url: "/v1/agents", headers: auth(), payload: { name: "Bot" } })).json();
    expect((await api.public.inject({ method: "POST", url: "/v1/account/keys/rotate", headers: { authorization: `Bearer ${agent.api_key}` } })).statusCode).toBe(403);
  });
});
