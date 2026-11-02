// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Footage encrypted at rest (ADR 0066), against real fMP4 segments in the
// compose object store (S3 on :59000): segments stored as HLS AES-128 play in
// ffmpeg through the signed playlist and its key link, clips keep their keys,
// snapshots are sealed, and deleting the account leaves nothing readable.
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import { handleMediaEvent } from "./indexer.js";
import { createKeyRing, decryptSegment, encryptSegment, envKeyWrapper, isSealed, openObject, sealObject, segmentIV, segmentKey } from "./keys.js";
import { createObjectStorage, encryptingStorage, readObject, type StorageConfig } from "./storage.js";
import { createTestDatabase } from "./testdb.js";

const S3: StorageConfig = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://localhost:59000", region: "us-east-1", bucket: "senseplane",
  accessKeyId: "senseplane", secretAccessKey: "senseplane-secret", forcePathStyle: true,
};
const s3 = new S3Client({ endpoint: S3.endpoint, region: S3.region, forcePathStyle: true, credentials: { accessKeyId: S3.accessKeyId!, secretAccessKey: S3.secretAccessKey! } });
const raw = async (Key: string) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: "senseplane", Key }))).Body!.transformToByteArray());
const FIXTURE = new URL("../../fixtures/testsrc-h264-640x360-20s.mp4", import.meta.url).pathname;
const MASTER = "test-master-key-".repeat(3);
const log = { warn() {}, error() {}, info() {} } as never;

function cutSegments() {
  const dir = mkdtempSync(join(tmpdir(), "sp-enc-"));
  execFileSync("ffmpeg", ["-v", "error", "-i", FIXTURE, "-t", "8", "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", join(dir, "seg_%03d.m4s"), "-hls_list_size", "0", join(dir, "index.m3u8")]);
  const durations = [...readFileSync(join(dir, "index.m3u8"), "utf8").matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
  return { dir, segs: readdirSync(dir).filter((f) => f.endsWith(".m4s")).sort(), durations };
}

/** Seconds of video ffmpeg could read from a playlist URL (it decrypts HLS AES-128 like players do). Async: the API answering it runs in this process. */
async function playableSeconds(url: string): Promise<number> {
  const { stdout: out } = await promisify(execFile)("ffmpeg", ["-v", "error", "-allowed_extensions", "ALL", "-i", url, "-map", "0:v", "-f", "null", "-", "-progress", "pipe:1"], { encoding: "utf8", timeout: 60_000 });
  const t = [...out.matchAll(/out_time_ms=(\d+)/g)].at(-1);
  return t ? Number(t[1]) / 1e6 : 0;
}

describe("encryption at rest", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let key: string;
  let src: string;
  let origin: string;
  const plain: Buffer[] = [];
  const objectKeys: string[] = [];
  const base = Date.now() - 3600_000;
  const auth = () => ({ authorization: `Bearer ${key}` });

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", storage: S3, sweepIntervalSeconds: 0, workers: false,
      mediaEncryptionKey: MASTER,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } },
    });
    origin = await api.public.listen({ port: 0, host: "127.0.0.1" });
    acc = (await api.data.accounts.create("Encrypted")).id;
    key = (await api.data.withAccount(acc, (s) => s.apiKeys.create("t"))).key;
    src = (await api.public.inject({ method: "POST", url: "/v1/sources", headers: auth(), payload: { name: "Door", type: "browser" } })).json().id;

    // The media plane's side: the init in clear, each segment encrypted with the key and IV the API hands out.
    const ring = createKeyRing(api.data, envKeyWrapper(MASTER));
    const dk = await ring.current(acc);
    const { dir, segs, durations } = cutSegments();
    const initKey = `raw/${acc}/${src}/init/a.mp4`;
    await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: initKey, Body: readFileSync(join(dir, "init.mp4")) }));
    let t0 = base;
    for (const [i, f] of segs.entries()) {
      const k = `raw/${acc}/${src}/x/${t0}.m4s`;
      const body = readFileSync(join(dir, f));
      const iv = segmentIV(dk.key, k);
      const sealed = encryptSegment(segmentKey(dk.key, src), iv, body);
      await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: k, Body: sealed }));
      await handleMediaEvent(api.data, "media.segment.written", {
        account_id: acc, source_id: src, key: k, init_key: initKey, start: new Date(t0).toISOString(), duration_ms: durations[i],
        bytes: sealed.length, codec: "h264", encryption: { method: "aes-128", key_id: String(dk.version), iv: iv.toString("hex") },
      }, log);
      plain.push(body);
      objectKeys.push(k);
      t0 += durations[i]!;
    }
  }, 60_000);
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  const playbackUrl = async (apiKey = key) => {
    const range = `from=${new Date(base).toISOString()}&to=${new Date(base + 60_000).toISOString()}`;
    const r = await api.public.inject({ url: `/v1/sources/${src}/playback?${range}`, headers: { authorization: `Bearer ${apiKey}` } });
    expect(r.statusCode).toBe(200);
    return origin + new URL(r.json().url).pathname;
  };

  it("stores segments encrypted; the playlist names their key and IV, and ffmpeg plays it", async () => {
    // At rest: not an fMP4 segment any more.
    const stored = await raw(objectKeys[0]!);
    expect(stored.equals(plain[0]!)).toBe(false);
    expect(stored.subarray(4, 8).toString()).not.toMatch(/styp|moof/);

    const url = await playbackUrl();
    const list = await (await fetch(url)).text();
    const keyLines = list.split("\n").filter((l) => l.startsWith("#EXT-X-KEY:METHOD=AES-128"));
    expect(keyLines).toHaveLength(objectKeys.length);
    expect(list.indexOf("#EXT-X-MAP")).toBeLessThan(list.indexOf("#EXT-X-KEY")); // the init is in clear

    // The key link, then each segment decrypts to what was recorded.
    const m = keyLines[0]!.match(/URI="([^"]+)",IV=0x([0-9a-f]{32})/)!;
    const dir = url.replace(/index\.m3u8$/, "");
    const k = Buffer.from(await (await fetch(dir + m[1])).arrayBuffer());
    expect(k).toHaveLength(16);
    const firstSeg = list.split("\n").find((l) => l.endsWith(".m4s"))!;
    const fetched = Buffer.from(await (await fetch(dir + firstSeg)).arrayBuffer());
    expect(decryptSegment(k, Buffer.from(m[2]!, "hex"), fetched).equals(plain[0]!)).toBe(true);

    // And a real HLS reader plays the whole range.
    expect(await playableSeconds(url)).toBeGreaterThan(6);
  });

  it("refuses the key to a bad link, and to video-only grants, which get decrypted segments instead", async () => {
    const url = await playbackUrl();
    const dir = url.replace(/index\.m3u8$/, "");
    expect((await fetch(dir.replace(/\/playback\/[^/]+\//, "/playback/nope/") + "k/1.key")).status).toBe(401);

    const agent = (await api.public.inject({ method: "POST", url: "/v1/agents", headers: auth(), payload: { name: "Viewer" } })).json();
    expect((await api.public.inject({ method: "POST", url: "/v1/grants", headers: auth(), payload: { agent_id: agent.id, source_ids: [src], senses: ["video"] } })).statusCode).toBe(201);
    const vUrl = await playbackUrl(agent.api_key);
    const vList = await (await fetch(vUrl)).text();
    expect(vList).not.toContain("#EXT-X-KEY");
    const vDir = vUrl.replace(/index\.m3u8$/, "");
    expect((await fetch(vDir + "k/1.key")).status).toBe(403);
    const seg = Buffer.from(await (await fetch(vDir + vList.split("\n").find((l) => l.endsWith(".m4s"))!)).arrayBuffer());
    expect(["styp", "moof"]).toContain(seg.subarray(4, 8).toString()); // in clear, from the API
    expect(await playableSeconds(vUrl)).toBeGreaterThan(6);
  });

  it("keeps a clip's segments encrypted with the same key and IVs", async () => {
    const r = await api.public.inject({
      method: "POST", url: "/v1/clips", headers: auth(),
      payload: { source: src, from: new Date(base).toISOString(), to: new Date(base + 5000).toISOString() },
    });
    expect(r.statusCode).toBe(201);
    const url = origin + new URL(r.json().playback_url).pathname;
    expect(await (await fetch(url)).text()).toContain("#EXT-X-KEY:METHOD=AES-128");
    expect(await playableSeconds(url)).toBeGreaterThan(3);
  });

  it("seals snapshots with the account's key; plain objects from before still read", async () => {
    const ring = createKeyRing(api.data, envKeyWrapper(MASTER));
    const store = encryptingStorage(createObjectStorage(S3), ring);
    const jpeg = Buffer.from("not really a jpeg, but bytes");
    const snap = `snapshots/${acc}/${src}/one.jpg`;
    await store.put(snap, jpeg, "image/jpeg");
    expect(isSealed(await raw(snap))).toBe(true);
    expect((await readObject(store, snap)).equals(jpeg)).toBe(true);
    expect(await store.presign(snap, 60)).toBeUndefined(); // never a direct link to ciphertext
    const legacy = `snapshots/${acc}/${src}/legacy.jpg`;
    await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: legacy, Body: jpeg }));
    expect((await readObject(store, legacy)).equals(jpeg)).toBe(true);
    // Another account's key doesn't open it.
    const other = (await api.data.accounts.create("Other")).id;
    await expect(openObject(ring, other, await sealObject(ring, acc, jpeg))).rejects.toThrow();
  });

  it("deleting the account deletes its keys: nothing stored can be read any more", async () => {
    const url = await playbackUrl();
    const dir = url.replace(/index\.m3u8$/, "");
    expect((await fetch(dir + "k/1.key")).status).toBe(200);
    expect((await api.public.inject({ method: "DELETE", url: "/v1/account", headers: auth() })).statusCode).toBe(202);
    const left = await api.data.withAccount(acc, (s) => s.db.selectFrom("account_keys").selectAll().execute());
    expect(left).toHaveLength(0);
    // A fresh ring (another API process) can't find a key for the segments or the snapshot.
    const ring = createKeyRing(api.data, envKeyWrapper(MASTER));
    expect(await ring.get(acc, 1)).toBeUndefined();
    await expect(openObject(ring, acc, await raw(`snapshots/${acc}/${src}/one.jpg`))).rejects.toThrow(/no longer exists/);
  });
});

describe("account keys", () => {
  it("wraps with the master key and the account id; another master or account can't unwrap", async () => {
    const w = envKeyWrapper(MASTER);
    const dk = Buffer.alloc(32, 7);
    const wrapped = await w.wrap(dk, "acc-1");
    expect((await w.unwrap(wrapped, "acc-1")).equals(dk)).toBe(true);
    await expect(w.unwrap(wrapped, "acc-2")).rejects.toThrow();
    await expect(envKeyWrapper("another-master-key-".repeat(2)).unwrap(wrapped, "acc-1")).rejects.toThrow();
    expect(() => envKeyWrapper("short")).toThrow(/32 characters/);
  });

  it("derives a different segment key per camera, and IVs per object", () => {
    const dk = Buffer.alloc(32, 1);
    expect(segmentKey(dk, "src_a").equals(segmentKey(dk, "src_b"))).toBe(false);
    expect(segmentIV(dk, "raw/a/1.m4s").equals(segmentIV(dk, "raw/a/2.m4s"))).toBe(false);
    const k = segmentKey(dk, "src_a");
    const iv = segmentIV(dk, "raw/a/1.m4s");
    const body = Buffer.from("x".repeat(1000));
    expect(decryptSegment(k, iv, encryptSegment(k, iv, body)).equals(body)).toBe(true);
  });
});
