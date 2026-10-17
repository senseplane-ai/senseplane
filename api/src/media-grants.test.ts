// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Grants on media links, audio removal for video-only
// grants, and revocation reaching already issued links. Needs the compose
// Postgres and object store, like the playback tests.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiBus, createApi, handleBrainEvent, type SenseplaneApi } from "./index.js";
import { audioTrackIds } from "./fmp4.js";
import { handleMediaEvent } from "./indexer.js";
import { createTestDatabase } from "./testdb.js";

const S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://localhost:59000", region: "us-east-1", bucket: "senseplane",
  accessKeyId: "senseplane", secretAccessKey: "senseplane-secret", forcePathStyle: true,
};
const s3 = new S3Client({ endpoint: S3.endpoint, region: S3.region, forcePathStyle: true, credentials: { accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey } });
const log = { warn() {}, error() {}, info() {} } as never;

/** fMP4 HLS segments with video and audio, like a recording with record_audio on. */
function avSegments() {
  const dir = mkdtempSync(join(tmpdir(), "sp-av-"));
  execFileSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "6", "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_list_size", "0",
    "-hls_segment_filename", join(dir, "seg_%03d.m4s"), join(dir, "index.m3u8"),
  ]);
  const durations = [...readFileSync(join(dir, "index.m3u8"), "utf8").matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
  return { dir, segs: readdirSync(dir).filter((f) => f.endsWith(".m4s")).sort(), durations };
}

describe("grants on media links", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let owner: string;
  let acc: string;
  let cam: string;
  let sensor: string;
  const base = Date.now() - 3600_000;
  let end = base;
  const bus: ApiBus = {
    async putSourceConfig() {},
    async latestSnapshot() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); },
    async putWatch() {},
    async close() {},
    async request<T>(): Promise<T> { return { vectors: [[1, ...new Array(383).fill(0)]] } as T; },
  };
  const call = (key: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const path = (url: string) => new URL(url).pathname;
  const agentWith = async (grant: Record<string, unknown>) => {
    const agent = (await call(owner, "POST", "/v1/agents", { name: `a${Math.random()}` })).json();
    expect((await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [cam, sensor], ...grant })).statusCode).toBe(201);
    return agent as { id: string; api_key: string };
  };
  const initOf = async (playlistUrl: string) => {
    const p = path(playlistUrl);
    const list = (await api.public.inject({ url: p })).body;
    const init = list.match(/#EXT-X-MAP:URI="([^"]+)"/)![1]!;
    const seg = list.split("\n").find((l) => l.endsWith(".m4s"))!;
    const dir = p.replace(/index\.m3u8$/, "");
    return { init: await api.public.inject({ url: dir + init }), seg: await api.public.inject({ url: dir + seg }) };
  };

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false, bus, storage: S3, sweepIntervalSeconds: 0,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } },
    });
    acc = (await api.data.accounts.create("Media grants")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    cam = (await call(owner, "POST", "/v1/sources", { name: "Door", type: "browser", record_audio: true })).json().id;
    sensor = (await call(owner, "POST", "/v1/sources", { name: "Kitchen", type: "sensor" })).json().id;
    const { dir, segs, durations } = avSegments();
    const initKey = `raw/${acc}/${cam}/init/a.mp4`;
    await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: initKey, Body: readFileSync(join(dir, "init.mp4")) }));
    for (const [i, f] of segs.entries()) {
      const k = `raw/${acc}/${cam}/x/a-${i}.m4s`;
      const body = readFileSync(join(dir, f));
      await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: k, Body: body }));
      await handleMediaEvent(api.data, "media.segment.written", {
        account_id: acc, source_id: cam, key: k, init_key: initKey, start: new Date(end).toISOString(),
        duration_ms: durations[i], bytes: body.length, codec: "h264",
      }, log);
      end += durations[i]!;
    }
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("serves video-only grants the recording without its audio track", async () => {
    const range = `from=${new Date(base).toISOString()}&to=${new Date(end).toISOString()}`;
    const ownerPb = (await call(owner, "GET", `/v1/sources/${cam}/playback?${range}`)).json();
    const own = await initOf(ownerPb.url);
    expect(own.init.statusCode).toBe(200);
    expect(audioTrackIds(own.init.rawPayload).size).toBe(1);

    const video = await agentWith({ senses: ["video"] });
    const pb = (await call(video.api_key, "GET", `/v1/sources/${cam}/playback?${range}`)).json();
    const vid = await initOf(pb.url);
    expect(vid.init.statusCode).toBe(200);
    expect(audioTrackIds(vid.init.rawPayload).size).toBe(0);
    expect(vid.seg.statusCode).toBe(200);
    expect(vid.seg.rawPayload.length).toBeLessThan(own.seg.rawPayload.length);

    const both = await agentWith({ senses: ["video", "audio"] });
    const pb2 = (await call(both.api_key, "GET", `/v1/sources/${cam}/playback?${range}`)).json();
    expect(audioTrackIds((await initOf(pb2.url)).init.rawPayload).size).toBe(1);
  });

  it("checks sense and time window on clips and event media", async () => {
    const clip = (await call(owner, "POST", "/v1/clips", { source: cam, from: new Date(base).toISOString(), to: new Date(end).toISOString() })).json();
    expect(clip.id).toBeTruthy();
    const audioOnly = await agentWith({ senses: ["audio"] });
    expect((await call(audioOnly.api_key, "GET", `/v1/clips/${clip.id}`)).statusCode).toBe(404);
    expect((await call(audioOnly.api_key, "GET", "/v1/clips")).json().data).toEqual([]);
    const past = await agentWith({ senses: ["video"], window: { from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" } });
    expect((await call(past.api_key, "GET", `/v1/clips/${clip.id}`)).statusCode).toBe(404);
    const video = await agentWith({ senses: ["video"] });
    const got = (await call(video.api_key, "GET", `/v1/clips/${clip.id}`)).json();
    expect(audioTrackIds((await initOf(got.playback_url)).init.rawPayload).size).toBe(0);

    // A sound event: an audio-only agent sees it, but gets no video links with it.
    await handleBrainEvent(api.data, undefined, "brain.event", {
      event_key: "snd1", account_id: acc, source_id: cam, type: "sound.detected", sense: "audio", occurred_at: new Date(base + 2000).toISOString(),
      labels: ["crying"], confidence: 0.9, summary: "Heard crying.",
    }, log, async () => [[1, ...new Array(383).fill(0)]]);
    const ev = (await call(audioOnly.api_key, "GET", "/v1/events")).json().data[0];
    expect(ev.type).toBe("sound.detected");
    expect(ev.media).toEqual({});
  });

  it("returns only granted senses inside the grant window from /history", async () => {
    const t0 = Date.now() - 600_000;
    const readings = [0, 1, 2, 3].flatMap((i) => [
      { sense: "temperature", value: 20 + i, unit: "celsius", measured_at: new Date(t0 + i * 60_000).toISOString() },
      { sense: "humidity", value: 40 + i, unit: "percent", measured_at: new Date(t0 + i * 60_000).toISOString() },
    ]);
    expect((await call(owner, "POST", `/v1/sources/${sensor}/readings`, { readings })).statusCode).toBe(202);
    const temp = await agentWith({ senses: ["temperature"], window: { from: new Date(t0 - 1).toISOString(), to: new Date(t0 + 90_000).toISOString() } });
    const h = (await call(temp.api_key, "GET", `/v1/sources/${sensor}/history?from=${new Date(t0 - 60_000).toISOString()}`)).json().data;
    expect(h.map((r: { sense: string; value: number }) => `${r.sense}:${r.value}`)).toEqual(["temperature:20", "temperature:21"]);
    expect((await call(temp.api_key, "GET", `/v1/sources/${sensor}/history?sense=humidity`)).statusCode).toBe(403);
  });

  it("revoking a key or its grant stops media links already issued", async () => {
    const range = `from=${new Date(base).toISOString()}&to=${new Date(end).toISOString()}`;
    const a = await agentWith({ senses: ["video"] });
    const pb = (await call(a.api_key, "GET", `/v1/sources/${cam}/playback?${range}`)).json();
    const now = (await call(a.api_key, "GET", `/v1/sources/${cam}/now`)).json();
    expect((await call(owner, "DELETE", `/v1/agents/${a.id}`)).statusCode).toBe(204);
    expect((await api.public.inject({ url: path(pb.url) })).statusCode).toBe(401);
    expect((await api.public.inject({ url: path(now.snapshot_url) })).statusCode).toBe(401);

    const b = await agentWith({ senses: ["video"] });
    const pb2 = (await call(b.api_key, "GET", `/v1/sources/${cam}/playback?${range}`)).json();
    const grants = (await call(owner, "GET", `/v1/grants?agent_id=${b.id}`)).json().data;
    for (const g of grants) await call(owner, "DELETE", `/v1/grants/${g.id}`);
    expect((await api.public.inject({ url: path(pb2.url) })).statusCode).toBe(403);
  });
});
