// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Following an object across cameras (ADR 0070), the API's side, against real
// encrypted recordings in the compose object store (S3 on :59000): frames are
// read from three cameras' recordings, sent to a brain (a stand-in here that
// matches by colour; the real matching is brain/tests/test_follow.py), and
// linked into a route in time order with the gap between, then a story. A
// person is refused, by description and by a box on one.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import jpeg from "jpeg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { namesAPerson, runFollow, sampleTimes } from "./follow.js";
import { createApi, type SenseplaneApi } from "./index.js";
import type { ApiBus } from "./indexer.js";
import { handleMediaEvent } from "./indexer.js";
import { createKeyRing, encryptSegment, envKeyWrapper, segmentIV, segmentKey } from "./keys.js";
import { renderStory } from "./stories.js";
import { createObjectStorage, encryptingStorage, type StorageConfig } from "./storage.js";
import { createTestDatabase } from "./testdb.js";

const S3: StorageConfig = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "http://localhost:59000", region: "us-east-1", bucket: "senseplane",
  accessKeyId: "senseplane", secretAccessKey: "senseplane-secret", forcePathStyle: true,
};
const s3 = new S3Client({ endpoint: S3.endpoint, region: S3.region, forcePathStyle: true, credentials: { accessKeyId: S3.accessKeyId!, secretAccessKey: S3.secretAccessKey! } });
const MASTER = "follow-test-master-key-".repeat(2);
const log = { warn() {}, error() {}, info() {} } as never;

/**
 * 10 s of a camera as ~2 s fMP4 segments: a plain room with a 80×60 box sprite of `colour` moving across
 * while `enable` holds (an ffmpeg expression in t), and a green "person" standing still on camera A.
 */
function recording(colour: string, enable: string, person = false) {
  const dir = mkdtempSync(join(tmpdir(), "sp-follow-src-"));
  const filter = [
    "[0:v][1:v]overlay=x='40+t*40':y='200-t*6':enable='" + enable + "'[a]",
    person ? "[a][2:v]overlay=x=520:y=120[v]" : "[a]null[v]",
  ].join(";");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x303438:s=640x360:r=15", "-f", "lavfi", "-i", `color=c=${colour}:s=80x60:r=15`,
    ...(person ? ["-f", "lavfi", "-i", "color=c=0x20c020:s=50x140:r=15"] : []),
    "-filter_complex", filter, "-map", "[v]", "-t", "10", "-c:v", "libx264", "-g", "30", "-pix_fmt", "yuv420p",
    "-f", "hls", "-hls_time", "2", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_list_size", "0",
    "-hls_segment_filename", join(dir, "seg_%03d.m4s"), join(dir, "index.m3u8")]);
  const durations = [...readFileSync(join(dir, "index.m3u8"), "utf8").matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 1000));
  return { dir, segs: readdirSync(dir).filter((f) => f.endsWith(".m4s")).sort(), durations };
}

/** A stand-in brain: the reference is the box's mean colour; green is a "person"; a sighting is a blob of that colour. */
function colourBrain() {
  const seen: { method: string; frames: number }[] = [];
  const decode = (b64: string) => jpeg.decode(Buffer.from(b64, "base64"), { useTArray: true });
  const bus: ApiBus = {
    async putSourceConfig() {},
    async putWatch() {},
    async latestSnapshot() { return undefined; },
    async close() {},
    async supports(feature: string) { return feature === "follow"; },
    async request<T>(subject: string, payload: unknown): Promise<T> {
      const p = payload as Record<string, unknown>;
      if (subject === "rpc.brain.follow_reference") {
        seen.push({ method: "reference", frames: 1 });
        const img = decode(p.jpeg_b64 as string);
        const [x1, y1, x2, y2] = (p.box as number[]).map((v, i) => Math.round(v * (i % 2 ? img.height : img.width)));
        const sum = [0, 0, 0];
        let n = 0;
        for (let y = y1!; y < y2!; y++) for (let x = x1!; x < x2!; x++) {
          const i = (y * img.width + x) * 4;
          for (let c = 0; c < 3; c++) sum[c]! += img.data[i + c]!;
          n++;
        }
        const mean = sum.map((v) => v / n);
        if (mean[1]! > 120 && mean[0]! < 100) return { error: "person" } as T;
        return { reference: { vector: mean, colour: [], label: null, crop_jpeg_b64: null }, model_calls: 0 } as T;
      }
      if (subject === "rpc.brain.follow_scan") {
        const frames = p.frames as { t: string; jpeg_b64: string }[];
        seen.push({ method: "scan", frames: frames.length });
        const ref = (p.reference as { vector: number[] }).vector;
        const sightings = [];
        for (const f of frames) {
          const img = decode(f.jpeg_b64);
          let [minX, minY, maxX, maxY, n] = [img.width, img.height, 0, 0, 0];
          for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
            const i = (y * img.width + x) * 4;
            const d = Math.abs(img.data[i]! - ref[0]!) + Math.abs(img.data[i + 1]! - ref[1]!) + Math.abs(img.data[i + 2]! - ref[2]!);
            if (d < 60) {
              n++;
              minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            }
          }
          if (n > 100) sightings.push({ t: f.t, box: [minX / img.width, minY / img.height, maxX / img.width, maxY / img.height], score: 0.9, confidence: 0.9, confirmed: null });
        }
        return { sightings, frames_examined: frames.length, model_calls: 0 } as T;
      }
      return { error: "unknown" } as T;
    },
  };
  return { bus, seen };
}

describe("following an object", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let acc: string;
  let owner: string;
  const cams: Record<string, string> = {};
  const brain = colourBrain();
  const base = Date.now() - 3600_000;
  const at = (ms: number) => new Date(base + ms).toISOString();
  const call = (key: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const deps = () => {
    const keys = createKeyRing(api.data, envKeyWrapper(MASTER));
    return { data: api.data, storage: encryptingStorage(createObjectStorage(S3), keys), keys, bus: brain.bus };
  };
  // The red box at t = 3 s on camera A: x = 40 + 3·40 = 160, y = 200 − 18 = 182.
  const box = [160 / 640, 182 / 360, 240 / 640, 242 / 360];

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, captureUrl: "https://c/capture.html", storage: S3, sweepIntervalSeconds: 0, workers: false,
      mediaEncryptionKey: MASTER, bus: brain.bus,
      media: { async createIngestSession() { return { id: "s", publish_url: "ws://m/" }; } },
    });
    acc = (await api.data.accounts.create("Follow")).id;
    owner = (await api.data.withAccount(acc, (s) => s.apiKeys.create("owner"))).key;
    const dk = await createKeyRing(api.data, envKeyWrapper(MASTER)).current(acc);
    // A: the red box crosses for 8 s (and a "person" stands by). B, 30 s later: a blue box. C, 60 s later: the red box again from 2 s.
    for (const [name, colour, enable, offset, person] of [["hall", "0xd02020", "lt(t,8)", 0, true], ["landing", "0x2040d0", "gte(t,0)", 30_000, false],
      ["kitchen", "0xd02020", "gte(t,2)", 60_000, false]] as const) {
      const src = (await call(owner, "POST", "/v1/sources", { name: name[0]!.toUpperCase() + name.slice(1), type: "browser" })).json().id;
      cams[name] = src;
      const { dir, segs, durations } = recording(colour, enable, person);
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
    await api?.close();
    await drop?.();
  });

  it("refuses a person, by description or by a box on one, and stores nothing", async () => {
    for (const description of ["the man in the red jacket", "my son", "a woman carrying a box", "the courier", "her"]) {
      const r = await call(owner, "POST", "/v1/follows", { reference: { description }, from: at(0), to: at(80_000) });
      expect(r.statusCode, description).toBe(403);
      expect(r.json().error.details.person).toBe(true);
    }
    const onPerson = await call(owner, "POST", "/v1/follows", { reference: { source: cams.hall, at: at(3000), box: [520 / 640, 120 / 360, 570 / 640, 260 / 360] }, from: at(0), to: at(80_000) });
    expect(onPerson.statusCode).toBe(403);
    expect(onPerson.json().error.message).toContain("doesn't follow people");
    expect(await api.data.withAccount(acc, (s) => s.db.selectFrom("follows").selectAll().execute())).toEqual([]);
  });

  it("tells a person from a person's thing in descriptions", () => {
    for (const d of ["the man in the red jacket", "my son", "Dad", "the delivery driver", "someone with a bag", "a child"]) expect(namesAPerson(d), d).toBe(true);
    for (const d of ["the brown cardboard box with red tape", "my son's backpack", "the cat", "the box the courier left", "a red suitcase", "the grey dog"]) {
      expect(namesAPerson(d), d).toBe(false);
    }
  });

  it("finds the box on two cameras in time order, reports the gap, and makes a story", async () => {
    const created = await call(owner, "POST", "/v1/follows", { reference: { source: cams.hall, at: at(3000), box }, from: at(0), to: at(80_000) });
    expect(created.statusCode).toBe(202);
    const queued = created.json();
    expect(queued).toMatchObject({ status: "queued", make_story: true });
    expect(queued.reference).toMatchObject({ source_id: cams.hall, box });
    expect(JSON.stringify(queued.reference)).not.toMatch(/vector|jpeg/); // no pixels, no embedding

    await runFollow(deps(), acc, queued.id);
    const done = (await call(owner, "GET", `/v1/follows/${queued.id}`)).json();
    expect(done.status).toBe("done");
    const route = done.result.route as { source_id: string; from: string; to: string; playback_url?: string }[];
    expect(route.map((v) => v.source_id)).toEqual([cams.hall, cams.kitchen]);
    expect(Date.parse(route[0]!.to) - base).toBeLessThan(9000); // gone from the hall by 8 s
    expect(Date.parse(route[1]!.from) - base).toBeGreaterThanOrEqual(61_000); // into the kitchen from 62 s
    expect(route.every((v) => v.playback_url?.includes("/playback/"))).toBe(true);
    expect(done.result.handovers).toEqual([expect.objectContaining({ from_source: cams.hall, to_source: cams.kitchen })]);
    expect(done.result.gaps).toHaveLength(1);
    expect(done.result.gaps[0].note).toContain("not seen on");
    expect(done.result.gaps[0].note).toContain("Landing"); // it was recording, and looked at
    expect(done.frames_examined).toBeGreaterThan(5);
    expect(done.frames_examined).toBeLessThanOrEqual(240);
    expect(done.result.limits).toMatchObject({ frames: 240, model_calls_cap: 12 });
    expect(brain.seen.filter((x) => x.method === "scan").every((x) => x.frames <= 20)).toBe(true);

    expect(done.story_id).toMatch(/^sty_/);
    const story = (await call(owner, "GET", `/v1/stories/${done.story_id}`)).json();
    expect(story.pieces.map((p: { source_id: string }) => p.source_id)).toEqual([cams.hall, cams.kitchen]);
    await renderStory(deps(), acc, done.story_id);
    expect((await call(owner, "GET", `/v1/stories/${done.story_id}`)).json().status).toBe("ready");
  }, 180_000);

  it("only looks at cameras the agent may watch, and refuses a blurred-only one", async () => {
    const agent = (await call(owner, "POST", "/v1/agents", { name: "Finder" })).json();
    await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [cams.hall, cams.landing], senses: ["video"] });
    const r = await call(agent.api_key, "POST", "/v1/follows", { reference: { source: cams.hall, at: at(3000), box }, from: at(0), to: at(80_000), make_story: false });
    expect(r.statusCode).toBe(202);
    expect(r.json().sources.sort()).toEqual([cams.hall, cams.landing].sort());
    expect((await call(agent.api_key, "POST", "/v1/follows", { reference: { source: cams.kitchen, at: at(63_000), box }, from: at(0), to: at(80_000) })).statusCode).toBe(404); // a camera it may not see
    expect((await call(agent.api_key, "GET", "/v1/follows")).json().data.map((f: { id: string }) => f.id)).toEqual([r.json().id]);

    const blurred = (await call(owner, "POST", "/v1/agents", { name: "Blurred" })).json();
    await call(owner, "POST", "/v1/grants", { agent_id: blurred.id, source_ids: [cams.hall], senses: ["video"], blurred_only: true });
    const b = await call(blurred.api_key, "POST", "/v1/follows", { reference: { source: cams.hall, at: at(3000), box }, from: at(0), to: at(80_000), sources: [cams.hall] });
    expect(b.statusCode).toBe(403);
    expect(b.json().error.details.blurred_only).toBe(true);
  }, 60_000);

  it("samples densely around events and sparsely elsewhere, within its budget", () => {
    const times = sampleTimes([{ from: 0, to: 60_000 }], [{ from: 10_000, to: 15_000 }], 20);
    expect(times.length).toBeLessThanOrEqual(20);
    expect(times.filter((t) => t >= 10_000 && t <= 15_000).length).toBeGreaterThanOrEqual(6); // a frame a second around the event
    expect(sampleTimes([{ from: 0, to: 3600_000 }], [], 50)).toHaveLength(50);
  });
});
