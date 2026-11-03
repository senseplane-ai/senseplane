// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Privacy blurring (ADR 0068): the settings (source over account) reach the
// brain, and a blurred-only agent gets blurred snapshots and looks but no
// recordings, clips or live view. Needs the compose Postgres and object store.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blurFor, blurredOnly, effectiveBlur } from "./blur.js";
import { type ApiBus, createApi, handleBrainEvent, type SenseplaneApi } from "./index.js";
import { handleMediaEvent } from "./indexer.js";
import { createObjectStorage } from "./storage.js";
import { createTestDatabase } from "./testdb.js";

const S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://localhost:59000", region: "us-east-1", bucket: "senseplane",
  accessKeyId: "senseplane", secretAccessKey: "senseplane-secret", forcePathStyle: true,
};
const s3 = new S3Client({ endpoint: S3.endpoint, region: S3.region, forcePathStyle: true, credentials: { accessKeyId: S3.accessKeyId, secretAccessKey: S3.secretAccessKey } });
const log = { warn() {}, error() {}, info() {} } as never;

const RAW = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]); // a "raw" snapshot
const BLURRED = Buffer.from([0xff, 0xd8, 0x02, 0xff, 0xd9]); // what the brain sends back

describe("pure rules", () => {
  it("a camera's own setting wins over the account's; both default off", () => {
    expect(effectiveBlur({}, undefined)).toEqual({ faces: false, plates: false });
    expect(effectiveBlur({ blur_faces: null, blur_plates: null }, { blur_faces: true, blur_plates: false })).toEqual({ faces: true, plates: false });
    expect(effectiveBlur({ blur_faces: false, blur_plates: true }, { blur_faces: true, blur_plates: false })).toEqual({ faces: false, plates: true });
  });
  it("a blurred-only grant on a source wins; account keys are never blurred-only", () => {
    const g = (ids: string[], bo: boolean) => ({ source_ids: ids, blurred_only: bo });
    expect(blurredOnly(undefined, "a")).toBe(false);
    expect(blurredOnly([g(["a"], false)], "a")).toBe(false);
    expect(blurredOnly([g(["a"], false), g(["a"], true)], "a")).toBe(true);
    expect(blurredOnly([g(["b"], true)], "a")).toBe(false);
    expect(blurFor({ access: { actor: "x", grants: [{ ...g(["a"], true), senses: ["video"], window_from: null, window_to: null }] } }, "a"))
      .toEqual({ blur: { faces: true, plates: true } });
    expect(blurFor({ access: { actor: "owner" } }, "a")).toEqual({});
  });
});

describe("privacy blurring", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let owner: string;
  let acc: string;
  let cam: string;
  let cam2: string;
  const base = Date.now() - 3600_000;
  let end = base;
  const configs = new Map<string, Record<string, unknown>>();
  const requests: { subject: string; payload: Record<string, unknown> }[] = [];
  const bus: ApiBus = {
    async putSourceConfig(a, s, config) { configs.set(`${a}.${s}`, config); },
    async latestSnapshot() { return RAW; },
    async putWatch() {},
    async close() {},
    async request<T>(subject: string, payload: unknown): Promise<T> {
      requests.push({ subject, payload: payload as Record<string, unknown> });
      if (subject === "rpc.brain.redact") return { jpeg_b64: BLURRED.toString("base64") } as T;
      if (subject === "rpc.brain.ask") return { answer: "Someone is at the door.", confidence: 0.9, snapshot_jpeg_b64: BLURRED.toString("base64") } as T;
      return { vectors: [[1, ...new Array(383).fill(0)]] } as T;
    },
  };
  const call = (key: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const path = (url: string) => new URL(url).pathname;
  const agentWith = async (grant: Record<string, unknown>) => {
    const agent = (await call(owner, "POST", "/v1/agents", { name: `a${Math.random()}` })).json();
    const g = await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [cam], senses: ["video"], ...grant });
    expect(g.statusCode).toBe(201);
    return { ...(agent as { id: string; api_key: string }), grant: g.json() };
  };
  const range = () => `from=${new Date(base).toISOString()}&to=${new Date(end).toISOString()}`;

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", workers: false, bus, storage: S3, sweepIntervalSeconds: 0,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } },
    });
    acc = (await api.data.accounts.create("Blurring")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    cam = (await call(owner, "POST", "/v1/sources", { name: "Door", type: "browser" })).json().id;
    cam2 = (await call(owner, "POST", "/v1/sources", { name: "Drive", type: "browser" })).json().id;
    const dir = mkdtempSync(join(tmpdir(), "sp-blur-"));
    execFileSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=15", "-t", "4", "-c:v", "libx264", "-g", "15", "-pix_fmt", "yuv420p",
      "-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_list_size", "0",
      "-hls_segment_filename", join(dir, "seg_%03d.m4s"), join(dir, "index.m3u8"),
    ]);
    const initKey = `raw/${acc}/${cam}/init/a.mp4`;
    await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: initKey, Body: readFileSync(join(dir, "init.mp4")) }));
    for (const [i, f] of readdirSync(dir).filter((x) => x.endsWith(".m4s")).sort().entries()) {
      const k = `raw/${acc}/${cam}/x/a-${i}.m4s`;
      const body = readFileSync(join(dir, f));
      await s3.send(new PutObjectCommand({ Bucket: "senseplane", Key: k, Body: body }));
      await handleMediaEvent(api.data, "media.segment.written", {
        account_id: acc, source_id: cam, key: k, init_key: initKey, start: new Date(end).toISOString(), duration_ms: 2000, bytes: body.length, codec: "h264",
      }, log);
      end += 2000;
    }
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  it("is off by default; the account's setting reaches every camera and a camera's own wins", async () => {
    expect((await call(owner, "GET", "/v1/account")).json()).toMatchObject({ blur_faces: false, blur_plates: false });
    expect((await call(owner, "GET", `/v1/sources/${cam}`)).json()).toMatchObject({ blur_faces: null, blur_plates: null });

    const acct = await call(owner, "PATCH", "/v1/account", { blur_faces: true });
    expect(acct.json()).toMatchObject({ blur_faces: true, blur_plates: false });
    expect(configs.get(`${acc}.${cam}`)?.blur).toEqual({ faces: true, plates: false });
    expect(configs.get(`${acc}.${cam2}`)?.blur).toEqual({ faces: true, plates: false });

    const src = await call(owner, "PATCH", `/v1/sources/${cam2}`, { blur_faces: false, blur_plates: true });
    expect(src.json()).toMatchObject({ blur_faces: false, blur_plates: true });
    expect(configs.get(`${acc}.${cam2}`)?.blur).toEqual({ faces: false, plates: true });
    expect(configs.get(`${acc}.${cam}`)?.blur).toEqual({ faces: true, plates: false });

    // Masks travel with it, as before.
    const masks = [[[0, 0], [0.2, 0], [0.2, 0.2]]];
    await call(owner, "PATCH", `/v1/sources/${cam}`, { privacy_masks: masks });
    expect(configs.get(`${acc}.${cam}`)).toMatchObject({ privacy_masks: masks, blur: { faces: true, plates: false } });

    // Back to the account's setting; then everything off again.
    await call(owner, "PATCH", `/v1/sources/${cam2}`, { blur_faces: null, blur_plates: null });
    expect(configs.get(`${acc}.${cam2}`)?.blur).toEqual({ faces: true, plates: false });
    await call(owner, "PATCH", "/v1/account", { blur_faces: false });
    expect(configs.get(`${acc}.${cam}`)?.blur).toEqual({ faces: false, plates: false });
    expect((await call(owner, "PATCH", "/v1/account", { blur_faces: "yes" })).statusCode).toBe(400);
  });

  it("a blurred-only agent is refused recordings, clips and live view", async () => {
    const plain = await agentWith({});
    expect(plain.grant.blurred_only).toBe(false);
    const bo = await agentWith({ blurred_only: true });
    expect(bo.grant.blurred_only).toBe(true);
    expect((await call(owner, "GET", "/v1/grants")).json().data.find((g: { id: string }) => g.id === bo.grant.id).blurred_only).toBe(true);

    expect((await call(plain.api_key, "GET", `/v1/sources/${cam}/playback?${range()}`)).statusCode).toBe(200);
    const pb = await call(bo.api_key, "GET", `/v1/sources/${cam}/playback?${range()}`);
    expect(pb.statusCode).toBe(403);
    expect(pb.json().error.details).toEqual({ blurred_only: true });
    expect((await call(bo.api_key, "POST", "/v1/clips", { source: cam, from: new Date(base).toISOString(), to: new Date(end).toISOString() })).statusCode).toBe(403);
    const clip = (await call(owner, "POST", "/v1/clips", { source: cam, from: new Date(base).toISOString(), to: new Date(end).toISOString() })).json();
    for (const r of [await call(bo.api_key, "GET", `/v1/clips/${clip.id}`), await call(bo.api_key, "POST", `/v1/sources/${cam}/live`, {})]) {
      expect(r.statusCode).toBe(403);
      expect(r.json().error.details).toEqual({ blurred_only: true });
    }
    expect((await call(plain.api_key, "GET", `/v1/clips/${clip.id}`)).statusCode).toBe(200);
  });

  it("a grant made blurred-only reaches a playback link issued before it", async () => {
    const a = await agentWith({});
    const pb = (await call(a.api_key, "GET", `/v1/sources/${cam}/playback?${range()}`)).json();
    expect((await call(owner, "POST", "/v1/grants", { agent_id: a.id, source_ids: [cam], senses: ["video"], blurred_only: true })).statusCode).toBe(201);
    expect((await api.public.inject({ url: path(pb.url) })).statusCode).toBe(403);
  });

  it("a blurred-only agent gets snapshots blurred by the brain; others get them as stored", async () => {
    const bo = await agentWith({ blurred_only: true });
    const plain = await agentWith({});

    // The latest snapshot.
    const boNow = (await call(bo.api_key, "GET", `/v1/sources/${cam}/now`)).json();
    requests.length = 0;
    const got = await api.public.inject({ url: path(boNow.snapshot_url) });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(BLURRED)).toBe(true);
    expect(requests).toEqual([{ subject: "rpc.brain.redact", payload: { account_id: acc, source_id: cam, jpeg_b64: RAW.toString("base64") } }]);
    const plainNow = (await call(plain.api_key, "GET", `/v1/sources/${cam}/now`)).json();
    expect((await api.public.inject({ url: path(plainNow.snapshot_url) })).rawPayload.equals(RAW)).toBe(true);

    // An event's snapshot, and no recording link with it.
    await handleBrainEvent(api.data, createObjectStorage(S3), "brain.event", {
      event_key: "p1", account_id: acc, source_id: cam, type: "detection.person", occurred_at: new Date(base + 1000).toISOString(),
      labels: ["person"], confidence: 0.9, summary: "A person was seen.", snapshot_jpeg_b64: RAW.toString("base64"),
    }, log, async () => [[1, ...new Array(383).fill(0)]]);
    const ev = (await call(bo.api_key, "GET", "/v1/events")).json().data.find((e: { type: string }) => e.type === "detection.person");
    expect(ev.media.clip_url).toBeUndefined();
    expect((await api.public.inject({ url: path(ev.media.snapshot_url) })).rawPayload.equals(BLURRED)).toBe(true);
    const evPlain = (await call(plain.api_key, "GET", "/v1/events")).json().data.find((e: { type: string }) => e.type === "detection.person");
    expect(evPlain.media.clip_url).toBeTruthy();
    expect((await api.public.inject({ url: path(evPlain.media.snapshot_url) })).rawPayload.equals(RAW)).toBe(true);
  });

  it("asks for a blurred look for a blurred-only agent, and not for the owner", async () => {
    const bo = await agentWith({ blurred_only: true });
    requests.length = 0;
    expect((await call(bo.api_key, "POST", `/v1/sources/${cam}/ask`, { question: "Who is at the door?" })).statusCode).toBe(200);
    expect((await call(owner, "POST", `/v1/sources/${cam}/ask`, { question: "Who is at the door?" })).statusCode).toBe(200);
    const asks = requests.filter((r) => r.subject === "rpc.brain.ask");
    expect(asks[0]!.payload.blur).toEqual({ faces: true, plates: true });
    expect(asks[1]!.payload.blur).toBeUndefined();
  });
});
