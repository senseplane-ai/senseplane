// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Multi-camera stories (ADR 0070), against real fMP4 recordings in the compose
// object store (S3 on :59000), encrypted as the media plane stores them: three
// cameras (one 4:3, one with sound) make one labelled video in time order with
// a gap card, which plays through its signed link, outlives the raw footage,
// and respects each agent's grants (video on every camera, audio only where
// granted, never for a blurred-only agent).
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audioTrackIds } from "./fmp4.js";
import { createApi, type SenseplaneApi, sweepOnce } from "./index.js";
import { handleMediaEvent } from "./indexer.js";
import { createKeyRing, encryptSegment, envKeyWrapper, segmentIV, segmentKey } from "./keys.js";
import { renderStory } from "./stories.js";
import { claim } from "./claims.js";
import { hashApiKey } from "./data/access.js";
import { runningFfmpeg, sweepWorkDirs } from "./ffmpeg.js";
import { createMediaGuard } from "./media-access.js";
import { createKeyRefSealer } from "./playback.js";
import { reencryptKeys } from "./rotation.js";
import { createObjectStorage, encryptingStorage, type StorageConfig } from "./storage.js";
import { createTestDatabase } from "./testdb.js";

const S3: StorageConfig = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://localhost:59000", region: "us-east-1", bucket: "senseplane",
  accessKeyId: "senseplane", secretAccessKey: "senseplane-secret", forcePathStyle: true,
};
const s3 = new S3Client({ endpoint: S3.endpoint, region: S3.region, forcePathStyle: true, credentials: { accessKeyId: S3.accessKeyId!, secretAccessKey: S3.secretAccessKey! } });
const fixture = (f: string) => new URL(`../../fixtures/${f}`, import.meta.url).pathname;
const MASTER = "story-test-master-key-".repeat(2);
const log = { warn() {}, error() {}, info() {} } as never;
const run = promisify(execFile);

/** ~2 s fMP4 segments of the first 8 s of a fixture, stream copied, like the recorder makes. */
function cutSegments(file: string) {
  const dir = mkdtempSync(join(tmpdir(), "sp-story-src-"));
  execFileSync("ffmpeg", ["-v", "error", "-i", fixture(file), "-t", "8", "-c", "copy", "-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4",
    "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", join(dir, "seg_%03d.m4s"), "-hls_list_size", "0", join(dir, "index.m3u8")]);
  const durations = [...readFileSync(join(dir, "index.m3u8"), "utf8").matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
  return { dir, segs: readdirSync(dir).filter((f) => f.endsWith(".m4s")).sort(), durations };
}

/** One frame of a playlist at `t` seconds, as 320×180 RGB. */
async function frameAt(url: string, t: number): Promise<Buffer> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-allowed_extensions", "ALL", "-ss", String(t), "-i", url, "-frames:v", "1", "-vf", "scale=320:180",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", timeout: 60_000, maxBuffer: 1 << 22 });
  return stdout;
}
const lum = (f: Buffer, x: number, y: number) => {
  const i = (y * 320 + x) * 3;
  return 0.299 * f[i]! + 0.587 * f[i + 1]! + 0.114 * f[i + 2]!;
};
/** Pixels in a region brighter than 170, and the region's median brightness. */
function region(f: Buffer, x0: number, y0: number, x1: number, y1: number) {
  const v: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) v.push(lum(f, x, y));
  v.sort((a, b) => a - b);
  return { bright: v.filter((x) => x > 170).length, median: v[Math.floor(v.length / 2)]!, spread: v[Math.floor(v.length * 0.95)]! - v[Math.floor(v.length * 0.05)]! };
}

/** Seconds decoded without an error, and the stream types, of a playlist URL. */
async function decode(url: string): Promise<{ seconds: number; streams: string[] }> {
  const { stdout } = await run("ffmpeg", ["-v", "error", "-xerror", "-allowed_extensions", "ALL", "-i", url, "-f", "null", "-", "-progress", "pipe:1"], { encoding: "utf8", timeout: 120_000 });
  const t = [...stdout.matchAll(/out_time_ms=(\d+)/g)].at(-1);
  const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-allowed_extensions", "ALL", "-show_streams", "-of", "json", url], { encoding: "utf8", timeout: 60_000 })).stdout);
  return { seconds: t ? Number(t[1]) / 1e6 : 0, streams: probe.streams.map((s: { codec_type: string }) => s.codec_type) };
}

describe("multi-camera stories", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let origin: string;
  let acc: string;
  let owner: string;
  const cams: Record<string, string> = {};
  const base = Date.now() - 3 * 86400_000; // recorded three days ago, so lowering retention sweeps it
  const at = (ms: number) => new Date(base + ms).toISOString();
  const call = (key: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const ring = () => createKeyRing(api.data, envKeyWrapper(MASTER));
  const deps = () => {
    const keys = ring();
    return { data: api.data, storage: encryptingStorage(createObjectStorage(S3), keys), keys };
  };
  const render = async (id: string) => {
    await renderStory(deps(), acc, id);
    return (await call(owner, "GET", `/v1/stories/${id}`)).json();
  };
  const agentWith = async (grants: Record<string, unknown>[]) => {
    const agent = (await call(owner, "POST", "/v1/agents", { name: `agent ${Math.random()}` })).json();
    for (const g of grants) expect((await call(owner, "POST", "/v1/grants", { agent_id: agent.id, ...g })).statusCode).toBe(201);
    return agent.api_key as string;
  };
  // Hall at 0 s, Kitchen 20 s later (4:3), Nursery (with sound) five minutes later.
  const moments = () => [
    { source: cams.nursery, from: at(300_000 + 1000), to: at(300_000 + 7000) },
    { source: cams.hall, from: at(1000), to: at(7000) },
    { source: cams.kitchen, from: at(21_000), to: at(27_000) },
  ];

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", storage: S3, sweepIntervalSeconds: 0, workers: false,
      mediaEncryptionKey: MASTER,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } },
    });
    origin = await api.public.listen({ port: 0, host: "127.0.0.1" });
    acc = (await api.data.accounts.create("Stories")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    const dk = await ring().current(acc);
    for (const [name, file, offset, audio] of [["hall", "testsrc-h264-640x360-20s.mp4", 0, false], ["kitchen", "dog-indoors-640x480.mp4", 20_000, false],
      ["nursery", "baby-crying-audio-640x360.mp4", 300_000, true]] as const) {
      const src = (await call(owner, "POST", "/v1/sources", { name: name[0]!.toUpperCase() + name.slice(1), type: "browser", record_audio: audio })).json().id;
      cams[name] = src;
      const { dir, segs, durations } = cutSegments(file);
      const initKey = `raw/${acc}/${src}/init/a.mp4`;
      await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: initKey, Body: readFileSync(join(dir, "init.mp4")) }));
      let t0 = base + offset;
      for (const [i, f] of segs.entries()) {
        const k = `raw/${acc}/${src}/x/${t0}.m4s`;
        const iv = segmentIV(dk.key, k);
        const sealed = encryptSegment(segmentKey(dk.key, src), iv, readFileSync(join(dir, f)));
        await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: k, Body: sealed }));
        await handleMediaEvent(api.data, "media.segment.written", {
          account_id: acc, source_id: src, key: k, init_key: initKey, start: new Date(t0).toISOString(), duration_ms: durations[i],
          bytes: sealed.length, codec: "h264", encryption: { method: "aes-128", key_id: String(dk.version), iv: iv.toString("hex") },
        }, log);
        t0 += durations[i]!;
      }
    }
  }, 90_000);
  afterAll(async () => {
    expect(runningFfmpeg()).toBe(0); // no render left an ffmpeg behind
    await api?.close();
    await drop?.();
  });

  let story: { id: string; playback_url: string; duration_ms: number; pieces: { source_id: string; offset_ms: number; recorded_ms: number }[] };

  it("puts three cameras in time order, labelled, with a card for the long gap, and it plays", async () => {
    const created = await call(owner, "POST", "/v1/stories", { title: "How the cat got out", moments: moments() });
    expect(created.statusCode).toBe(202);
    const queued = created.json();
    expect(queued.status).toBe("queued");
    expect(queued.pieces.map((p: { source_id: string }) => p.source_id)).toEqual([cams.hall, cams.kitchen, cams.nursery]);
    expect(queued.pieces[2].gap_before_ms).toBeGreaterThan(270_000);
    expect(queued.pieces[2].audio).toBe(true);

    story = await render(queued.id);
    expect(story).toMatchObject({ status: "ready", has_audio: true, mode: "labelled" });
    // 3 × 6 s of video and a 2 s card.
    expect(story.duration_ms).toBeGreaterThan(18_000);
    expect(story.duration_ms).toBeLessThan(22_500);
    const offsets = story.pieces.map((p) => p.offset_ms);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    for (const p of story.pieces) expect(p.recorded_ms).toBeGreaterThan(5000);

    const url = origin + new URL(story.playback_url).pathname;
    const { seconds, streams } = await decode(url);
    expect(seconds).toBeGreaterThan(18);
    expect(streams).toEqual(expect.arrayContaining(["video", "audio"]));

    // The pictures are the cameras in order: the test pattern, the 4:3 dog (black bars at the sides), the card, the dark nursery.
    const [hall, kitchen, nursery] = story.pieces;
    const fHall = await frameAt(url, (hall!.offset_ms + 3000) / 1000);
    const fKitchen = await frameAt(url, (kitchen!.offset_ms + 3000) / 1000);
    const fCard = await frameAt(url, (nursery!.offset_ms - 1000) / 1000);
    const fNursery = await frameAt(url, (nursery!.offset_ms + 3000) / 1000);
    expect(region(fHall, 0, 60, 320, 140).spread).toBeGreaterThan(60); // colour bars across the frame
    expect(region(fHall, 0, 20, 30, 150).median).toBeGreaterThan(30); // ... right to the edge
    expect(region(fKitchen, 0, 20, 30, 150).median).toBeLessThan(20); // pillarbox
    expect(region(fKitchen, 0, 20, 30, 150).spread).toBeLessThan(20);
    expect(region(fCard, 100, 60, 220, 100).bright).toBeGreaterThan(30); // "+5 min"
    expect(region(fCard, 0, 172, 320, 180).bright).toBe(0); // a card has no caption bar
    // Every piece has its caption bar: dark, with lettering in it.
    for (const f of [fHall, fKitchen, fNursery]) {
      const bar = region(f, 0, 172, 320, 180);
      expect(bar.median).toBeLessThan(80);
      expect(bar.bright).toBeGreaterThan(15);
    }
  }, 180_000);

  it("is stored encrypted, survives deleting the raw recordings, and its shared link plays without a key", async () => {
    const segs = await api.data.withAccount(acc, (s) => s.db.selectFrom("story_segments").selectAll().where("story_id", "=", story.id).execute());
    expect(segs.length).toBeGreaterThan(3);
    expect(segs.every((x) => x.enc_version !== null && x.key_source === story.id && x.key.startsWith(`stories/${acc}/${story.id}/`))).toBe(true);

    await api.data.withAccount(acc, (s) => s.db.updateTable("sources").set({ retention_days: 1 }).execute());
    const swept = await sweepOnce(api.data, createObjectStorage(S3));
    expect(swept.segments).toBeGreaterThan(0);
    expect(await api.data.withAccount(acc, (s) => s.db.selectFrom("segments").selectAll().execute())).toEqual([]);

    const link = await call(owner, "POST", `/v1/stories/${story.id}/link`, { expires_in_s: 3600 });
    expect(link.statusCode).toBe(200);
    const shared = link.json();
    expect(Date.parse(shared.expires_at) - Date.now()).toBeGreaterThan(3500_000);
    const { seconds } = await decode(origin + new URL(shared.url).pathname);
    expect(seconds).toBeGreaterThan(18);
    expect((await api.public.inject(new URL(shared.url).pathname.replace(/\.[^.]+\/index/, "x.y/index"))).statusCode).toBe(401);
  }, 120_000);

  it("refuses an agent without video on one of the cameras", async () => {
    // Re-record nothing: the grant check comes before anything is read.
    const agent = await agentWith([{ source_ids: [cams.hall, cams.kitchen], senses: ["video", "audio"] }, { source_ids: [cams.nursery], senses: ["audio"] }]);
    const r = await call(agent, "POST", "/v1/stories", { moments: moments() });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe("forbidden_sense");
    // Nor does it see the owner's story, which shows that camera.
    expect((await call(agent, "GET", `/v1/stories/${story.id}`)).statusCode).toBe(404);
    expect((await call(agent, "GET", "/v1/stories")).json().data).toEqual([]);
  });

  it("refuses a blurred-only agent: recordings aren't blurred", async () => {
    const agent = await agentWith([{ source_ids: [cams.hall, cams.kitchen, cams.nursery], senses: ["video"], blurred_only: true }]);
    const r = await call(agent, "POST", "/v1/stories", { moments: moments() });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.details.blurred_only).toBe(true);
  });

  it("strips audio for an agent with video but no audio grant", async () => {
    const agent = await agentWith([{ source_ids: [cams.hall, cams.kitchen, cams.nursery], senses: ["video"] }]);
    // The owner's story (with sound) is served to it without the audio track.
    const own = (await call(agent, "GET", `/v1/stories/${story.id}`)).json();
    const p = new URL(own.playback_url).pathname;
    const list = (await api.public.inject(p)).body;
    expect(list).not.toContain("#EXT-X-KEY");
    const init = (await api.public.inject(p.replace(/index\.m3u8$/, "") + list.match(/#EXT-X-MAP:URI="([^"]+)"/)![1])).rawPayload;
    expect(audioTrackIds(init).size).toBe(0);
    expect((await decode(origin + p)).streams).toEqual(["video"]);
  }, 120_000);

  it("renders an agent's own story without the sound it may not hear", async () => {
    // Recordings were swept above: record the nursery again, then the agent makes its story.
    const dk = await ring().current(acc);
    await api.data.withAccount(acc, (s) => s.db.updateTable("sources").set({ retention_days: null }).execute());
    const { dir, segs, durations } = cutSegments("baby-crying-audio-640x360.mp4");
    const src = cams.nursery!;
    const initKey = `raw/${acc}/${src}/init/b.mp4`;
    await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: initKey, Body: readFileSync(join(dir, "init.mp4")) }));
    const t0 = Date.now() - 600_000;
    let t = t0;
    for (const [i, f] of segs.entries()) {
      const k = `raw/${acc}/${src}/x/${t}.m4s`;
      const iv = segmentIV(dk.key, k);
      const sealed = encryptSegment(segmentKey(dk.key, src), iv, readFileSync(join(dir, f)));
      await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: k, Body: sealed }));
      await handleMediaEvent(api.data, "media.segment.written", {
        account_id: acc, source_id: src, key: k, init_key: initKey, start: new Date(t).toISOString(), duration_ms: durations[i],
        bytes: sealed.length, codec: "h264", encryption: { method: "aes-128", key_id: String(dk.version), iv: iv.toString("hex") },
      }, log);
      t += durations[i]!;
    }
    const agent = await agentWith([{ source_ids: [src], senses: ["video"] }]);
    const created = await call(agent, "POST", "/v1/stories", { moments: [{ source: src, from: new Date(t0).toISOString(), to: new Date(t0 + 5000).toISOString() }] });
    expect(created.statusCode).toBe(202);
    expect(created.json().pieces[0].audio).toBe(false);
    const done = await render(created.json().id);
    expect(done).toMatchObject({ status: "ready", has_audio: false });
    const mine = (await call(agent, "GET", `/v1/stories/${done.id}`)).json();
    expect((await decode(origin + new URL(mine.playback_url).pathname)).streams).toEqual(["video"]);
    expect((await call(agent, "GET", "/v1/stories")).json().data.map((x: { id: string }) => x.id)).toContain(done.id);
  }, 120_000);

  /** A fast story of the nursery's latest recording (recorded again by the test above). */
  const fastStory = async (key: string) => {
    const src = cams.nursery!;
    const seg = await api.data.withAccount(acc, (s) => s.db.selectFrom("segments").selectAll().where("source_id", "=", src).orderBy("start_at").execute());
    const from = new Date(seg[0]!.start_at).getTime();
    const created = await call(key, "POST", "/v1/stories", { mode: "fast", moments: [{ source: src, from: new Date(from).toISOString(), to: new Date(from + 5000).toISOString() }] });
    expect(created.statusCode).toBe(202);
    await renderStory(deps(), acc, created.json().id);
    return (await call(key, "GET", `/v1/stories/${created.json().id}`)).json();
  };

  it("fast mode copies the recordings without re-encoding, under the story's own key, and deleting it removes its objects", async () => {
    const done = await fastStory(owner);
    expect(done).toMatchObject({ status: "ready", mode: "fast" });
    const rows = await api.data.withAccount(acc, (s) => s.db.selectFrom("story_segments").selectAll().where("story_id", "=", done.id).execute());
    expect(rows.every((r) => r.key_source === done.id)).toBe(true);
    // Its link hands out the story's key, never the camera's.
    const p = new URL(done.playback_url).pathname;
    const list = (await api.public.inject(p)).body;
    const keyUri = list.match(/URI="(k\/[^"]+)"/)![1]!;
    const served = (await api.public.inject(p.replace(/index\.m3u8$/, "") + keyUri)).rawPayload;
    const dk = await ring().get(acc, rows[0]!.enc_version!);
    expect(served.equals(segmentKey(dk!, done.id))).toBe(true);
    expect(served.equals(segmentKey(dk!, cams.nursery!))).toBe(false);
    // Only story segments answer on it: a recording's segment id is not a story seq.
    expect((await api.public.inject(p.replace(/index\.m3u8$/, "") + `k/${rows[0]!.enc_version}-9999.key`)).statusCode).toBe(404);
    const { seconds, streams } = await decode(origin + p);
    expect(seconds).toBeGreaterThan(3);
    expect(streams).toEqual(expect.arrayContaining(["video", "audio"]));

    expect((await call(owner, "DELETE", `/v1/stories/${done.id}`)).statusCode).toBe(204);
    expect((await call(owner, "GET", `/v1/stories/${done.id}`)).statusCode).toBe(404);
    expect((await api.public.inject(p)).statusCode).toBe(404);
    const left: string[] = [];
    for await (const k of createObjectStorage(S3).list!(`stories/${acc}/${done.id}/`)) left.push(k);
    expect(left).toEqual([]);
  }, 120_000);

  it("fast mode for an agent without audio: no key, no audio track", async () => {
    const agent = await agentWith([{ source_ids: [cams.nursery], senses: ["video"] }]);
    const done = await fastStory(agent);
    expect(done.pieces[0].audio).toBe(false);
    const p = new URL(done.playback_url).pathname;
    const list = (await api.public.inject(p)).body;
    expect(list).not.toContain("#EXT-X-KEY");
    const init = (await api.public.inject(p.replace(/index\.m3u8$/, "") + list.match(/#EXT-X-MAP:URI="([^"]+)"/)![1])).rawPayload;
    expect(audioTrackIds(init).size).toBe(0);
    expect((await decode(origin + p)).streams).toEqual(["video"]);
  }, 120_000);

  it("a link stops working when the agent's grant is taken away", async () => {
    const agentKey = await agentWith([{ source_ids: [cams.nursery], senses: ["video"] }]);
    const done = await fastStory(agentKey);
    const sealer = createKeyRefSealer("guard-test");
    const guard = createMediaGuard(api.data, sealer, 0); // no cache: the revocation is seen at once
    const scope = { kind: "story" as const, accountId: acc, storyId: done.id, kr: sealer.seal(hashApiKey(agentKey)) };
    await expect(guard(scope)).resolves.toMatchObject({ blurredOnly: false });
    const agentId = (await api.data.principalForKeyHash(hashApiKey(agentKey)))!.agentId!;
    await api.data.withAccount(acc, (s) => s.db.deleteFrom("grants").where("agent_id", "=", agentId).execute());
    await expect(guard(scope)).rejects.toMatchObject({ status: 403 });
  }, 120_000);

  it("key rotation re-encrypts story segments, and the story keeps playing", async () => {
    const done = await fastStory(owner);
    const before = await api.data.withAccount(acc, (s) => s.db.selectFrom("story_segments").select("enc_version").where("story_id", "=", done.id).execute());
    expect((await call(owner, "POST", "/v1/account/keys/rotate")).statusCode).toBe(202);
    const wrapper = envKeyWrapper(MASTER);
    await reencryptKeys({ data: api.data, storage: createObjectStorage(S3), keys: createKeyRing(api.data, wrapper), wrapper }, 60_000);
    const after = await api.data.withAccount(acc, (s) => s.db.selectFrom("story_segments").select("enc_version").where("story_id", "=", done.id).execute());
    expect(after.every((r) => r.enc_version! > before[0]!.enc_version!)).toBe(true);
    const fresh = (await call(owner, "GET", `/v1/stories/${done.id}`)).json();
    expect((await decode(origin + new URL(fresh.playback_url).pathname)).seconds).toBeGreaterThan(3);
  }, 120_000);

  it("only one process holds a render; a lost claim writes and deletes nothing; claims stop after three attempts", async () => {
    const src = cams.nursery!;
    const seg = await api.data.withAccount(acc, (s) => s.db.selectFrom("segments").selectAll().where("source_id", "=", src).orderBy("start_at").execute());
    const from = new Date(seg.at(-1)!.start_at).getTime() - 4000;
    const make = async () => (await call(owner, "POST", "/v1/stories", { mode: "fast", moments: [{ source: src, from: new Date(from).toISOString(), to: new Date(from + 3000).toISOString() }] })).json().id as string;
    const id = await make();
    const [a, b] = await Promise.all([claim(api.data, "stories", 10), claim(api.data, "stories", 10)]);
    const mine = [...a, ...b].filter((x) => x.id === id);
    expect(mine).toHaveLength(1); // two processes, one claim
    const first = mine[0]!;
    // Its lease runs out (the process hangs); another takes it over with a new token.
    await api.data.withAccount(acc, (s) => s.db.updateTable("stories").set({ claimed_until: new Date(Date.now() - 1000) }).where("id", "=", id).execute());
    const second = (await claim(api.data, "stories", 10)).find((x) => x.id === id)!;
    expect(second.token).not.toBe(first.token);
    await renderStory(deps(), acc, id, undefined, second);
    const ready = await api.data.withAccount(acc, (s) => s.db.selectFrom("stories").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
    expect(ready.status).toBe("ready");
    const objects = async () => {
      const out: string[] = [];
      for await (const k of createObjectStorage(S3).list!(`stories/${acc}/${id}/`)) out.push(k);
      return out.sort();
    };
    const kept = await objects();
    expect(kept.length).toBeGreaterThan(1);
    // The first process wakes up: its claim is gone, so it renders, writes and deletes nothing of the ready story.
    await renderStory(deps(), acc, id, undefined, first);
    expect(await objects()).toEqual(kept);
    expect((await api.data.withAccount(acc, (s) => s.db.selectFrom("stories").selectAll().where("id", "=", id).executeTakeFirstOrThrow())).ready_at).toEqual(ready.ready_at);

    // A story whose process keeps dying is given up after three claims.
    const doomed = await make();
    await api.data.withAccount(acc, (s) => s.db.updateTable("stories").set({ attempts: 3, claimed_until: new Date(Date.now() - 1000), status: "rendering" }).where("id", "=", doomed).execute());
    expect((await claim(api.data, "stories", 10)).find((x) => x.id === doomed)).toBeUndefined();
    expect((await call(owner, "GET", `/v1/stories/${doomed}`)).json()).toMatchObject({ status: "failed" });
  }, 120_000);

  it("a render stopped by its deadline leaves no ffmpeg running and goes back to the queue", async () => {
    const src = cams.nursery!;
    const seg = await api.data.withAccount(acc, (s) => s.db.selectFrom("segments").selectAll().where("source_id", "=", src).orderBy("start_at").execute());
    const from = new Date(seg[0]!.start_at).getTime();
    const id = (await call(owner, "POST", "/v1/stories", { moments: [{ source: src, from: new Date(from).toISOString(), to: new Date(from + 5000).toISOString() }] })).json().id;
    await renderStory(deps(), acc, id, undefined, undefined, { deadlineMs: 300 });
    expect(runningFfmpeg()).toBe(0);
    const row = await api.data.withAccount(acc, (s) => s.db.selectFrom("stories").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
    expect(row).toMatchObject({ status: "queued", claim_token: null });
    const left: string[] = [];
    for await (const k of createObjectStorage(S3).list!(`stories/${acc}/${id}/`)) left.push(k);
    expect(left).toEqual([]);
  }, 60_000);

  it("sweeps work dirs a crashed process left, and keeps ones in use", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sp-sweep-"));
    const old = join(dir, "sp-story-old");
    const fresh = join(dir, "sp-follow-new");
    mkdirSync(old);
    mkdirSync(fresh);
    writeFileSync(join(old, "piece.mp4"), "x");
    utimesSync(old, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    mkdirSync(join(dir, "unrelated"));
    utimesSync(join(dir, "unrelated"), new Date(0), new Date(0));
    expect(await sweepWorkDirs(20 * 60_000, dir)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["sp-follow-new", "unrelated"]);
  });

  it("checks its limits", async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ source: cams.hall, from: at(i * 10_000), to: at(i * 10_000 + 1000) }));
    const r = await call(owner, "POST", "/v1/stories", { moments: many });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toContain("at most 20 pieces");
    const long = [0, 1, 2, 3].map((i) => ({ source: Object.values(cams)[i % 3], from: at(i * 600_000), to: at(i * 600_000 + 170_000) }));
    expect((await call(owner, "POST", "/v1/stories", { moments: long })).json().error.message).toContain("at most 10 minutes");
    expect((await call(owner, "POST", "/v1/stories", {})).statusCode).toBe(400);
  });
});
