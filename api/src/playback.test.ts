// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Integration: signed HLS, timeline, clips and the retention sweeper,
// against real fMP4 segments in the compose object store (S3 on :59000).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi, sweepOnce } from "./index.js";
import { handleMediaEvent } from "./indexer.js";
import { createObjectStorage, type StorageConfig } from "./storage.js";
import { createTestDatabase } from "./testdb.js";

const S3: StorageConfig = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://localhost:59000", region: "us-east-1", bucket: "senseplane",
  accessKeyId: "senseplane", secretAccessKey: "senseplane-secret", forcePathStyle: true,
};
const s3 = new S3Client({ endpoint: S3.endpoint, region: S3.region, forcePathStyle: true, credentials: { accessKeyId: S3.accessKeyId!, secretAccessKey: S3.secretAccessKey! } });
const FIXTURE = new URL("../../fixtures/testsrc-h264-640x360-20s.mp4", import.meta.url).pathname;
const exists = async (Key: string) => s3.send(new GetObjectCommand({ Bucket: "senseplane", Key })).then(() => true, () => false);
const log = { warn() {}, error() {}, info() {} } as never;

/** Cuts the fixture into ~2 s fMP4 segments (stream copy), like the recorder does. */
function cutSegments() {
  const dir = mkdtempSync(join(tmpdir(), "sp-pb-"));
  execFileSync("ffmpeg", ["-v", "error", "-i", FIXTURE, "-t", "8", "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", join(dir, "seg_%03d.m4s"), "-hls_list_size", "0", join(dir, "index.m3u8")]);
  const durations = [...readFileSync(join(dir, "index.m3u8"), "utf8").matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
  return { dir, segs: readdirSync(dir).filter((f) => f.endsWith(".m4s")).sort(), durations };
}

describe("playback, timeline, clips, retention", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let key: string;
  let acc: string;
  let src: string;
  const auth = () => ({ authorization: `Bearer ${key}` });
  const base = Date.now() - 3 * 86400_000; // recorded three days ago
  let sessionB: number;

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", storage: S3, sweepIntervalSeconds: 0,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } },
    });
    acc = (await api.data.accounts.create("Playback")).id;
    key = (await api.data.withAccount(acc, (s) => s.apiKeys.create("t"))).key;
    src = (await api.public.inject({ method: "POST", url: "/v1/sources", headers: auth(), payload: { name: "Door", type: "browser" } })).json().id;

    // Two recorder sessions (different init segments) with a 60 s gap between them.
    const { dir, segs, durations } = cutSegments();
    let t0 = base;
    for (const [session, offset] of [["a", 0], ["b", 60_000]] as const) {
      const initKey = `raw/${acc}/${src}/init/${session}.mp4`;
      await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: initKey, Body: readFileSync(join(dir, "init.mp4")) }));
      t0 += offset;
      if (session === "b") sessionB = t0;
      for (const [i, f] of segs.entries()) {
        const k = `raw/${acc}/${src}/x/${session}-${i}.m4s`;
        const body = readFileSync(join(dir, f));
        await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: k, Body: body }));
        await handleMediaEvent(api.data, "media.segment.written", {
          account_id: acc, source_id: src, key: k, init_key: initKey, start: new Date(t0).toISOString(),
          duration_ms: durations[i], bytes: body.length, codec: "h264",
        }, log);
        t0 += durations[i]!;
      }
    }
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("shows recorded ranges and the gap on the timeline", async () => {
    const r = await api.public.inject({ url: `/v1/sources/${src}/timeline?from=${new Date(base - 60_000).toISOString()}&to=${new Date(base + 600_000).toISOString()}`, headers: auth() });
    const tl = r.json();
    expect(tl.recorded).toHaveLength(2);
    expect(tl.gaps).toHaveLength(1);
    expect(Date.parse(tl.gaps[0].to) - Date.parse(tl.gaps[0].from)).toBeGreaterThanOrEqual(59_000);
    expect(tl.retention_days).toBe(7);
  });

  it("serves a signed HLS playlist across the gap, and the segments play as H.264", async () => {
    const r = await api.public.inject({ url: `/v1/sources/${src}/playback?from=${new Date(base).toISOString()}&to=${new Date(base + 600_000).toISOString()}`, headers: auth() });
    expect(r.statusCode).toBe(200);
    const { url, gaps } = r.json();
    expect(gaps).toHaveLength(1);
    const path = new URL(url).pathname;
    const t0 = Date.now();
    const playlist = (await api.public.inject(path)).body;
    expect(playlist).toContain("#EXT-X-DISCONTINUITY");
    expect(playlist.match(/#EXT-X-MAP/g)).toHaveLength(2);
    const dir = path.replace(/index\.m3u8$/, "");
    const init = (await api.public.inject(dir + playlist.match(/URI="([^"]+)"/)![1])).rawPayload;
    const first = (await api.public.inject(dir + playlist.split("\n").find((l) => l.startsWith("s/"))!)).rawPayload;
    const startMs = Date.now() - t0;
    const file = join(mkdtempSync(join(tmpdir(), "sp-pb-probe-")), "a.mp4");
    writeFileSync(file, Buffer.concat([init, first]));
    expect(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]).toString()).streams[0].codec_name).toBe("h264");
    expect(startMs).toBeLessThan(2000); // playlist + init + first segment
  });

  it("rejects tampered playback links and segments outside the signed range", async () => {
    expect((await api.public.inject("/playback/abc.def/index.m3u8")).statusCode).toBe(401);
    const r = await api.public.inject({ url: `/v1/sources/${src}/playback?from=${new Date(base).toISOString()}&to=${new Date(base + 4000).toISOString()}`, headers: auth() });
    const dir = new URL(r.json().url).pathname.replace(/index\.m3u8$/, "");
    const late = await api.data.withAccount(acc, (s) => s.db.selectFrom("segments").select("id").where("start_at", ">=", new Date(sessionB)).executeTakeFirstOrThrow());
    expect((await api.public.inject(`${dir}s/${late.id}.m4s`)).statusCode).toBe(404);
    expect((await api.public.inject({ url: `/v1/sources/${src}/playback?from=${new Date(base).toISOString()}&to=${new Date(base + 25 * 3600_000).toISOString()}`, headers: auth() })).statusCode).toBe(400);
  });

  it("keeps clips playable after the sweeper deletes their raw segments", async () => {
    const created = await api.public.inject({
      method: "POST", url: "/v1/clips", headers: auth(),
      payload: { source: src, from: new Date(base).toISOString(), to: new Date(base + 5000).toISOString(), title: "Delivery" },
    });
    expect(created.statusCode).toBe(201);
    const clip = created.json();
    expect(clip).toMatchObject({ source_id: src, title: "Delivery" });
    expect(clip.duration_ms).toBeGreaterThan(3000);

    // Lower the source's retention to 1 day: everything (3 days old) is now expired.
    const other = (await api.data.accounts.create("Untouched")).id;
    await api.data.withAccount(acc, (s) => s.db.updateTable("sources").set({ retention_days: 1 }).where("id", "=", src).execute());
    const rawKeys = await api.data.withAccount(acc, (s) => s.db.selectFrom("segments").select(["key", "init_key"]).execute());
    const swept = await sweepOnce(api.data, createObjectStorage(S3));
    expect(swept.segments).toBe(rawKeys.length);
    for (const k of new Set(rawKeys.flatMap((r) => [r.key, r.init_key]))) expect(await exists(k)).toBe(false);
    expect(await api.data.withAccount(acc, (s) => s.db.selectFrom("segments").selectAll().execute())).toEqual([]);
    void other;

    const fresh = (await api.public.inject({ url: `/v1/clips/${clip.id}`, headers: auth() })).json();
    const path = new URL(fresh.playback_url).pathname;
    const playlist = (await api.public.inject(path)).body;
    const dir = path.replace(/index\.m3u8$/, "");
    const init = await api.public.inject(dir + playlist.match(/URI="([^"]+)"/)![1]);
    const seg = await api.public.inject(dir + playlist.split("\n").find((l) => l.startsWith("s/"))!);
    expect(init.statusCode).toBe(200);
    expect(seg.statusCode).toBe(200);
    const file = join(mkdtempSync(join(tmpdir(), "sp-clip-")), "c.mp4");
    writeFileSync(file, Buffer.concat([init.rawPayload, seg.rawPayload]));
    expect(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]).toString()).streams[0].codec_name).toBe("h264");

    expect((await api.public.inject({ method: "DELETE", url: `/v1/clips/${clip.id}`, headers: auth() })).statusCode).toBe(204);
    expect(await exists(`clips/${acc}/${clip.id}/00000.m4s`)).toBe(false);
  });
});
