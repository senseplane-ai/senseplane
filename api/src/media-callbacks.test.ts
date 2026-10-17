// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The media plane's callbacks (spec/media/callbacks.json, ADR 0049) against
// the real media driver and a fake media plane: tokens, presigned uploads
// scoped to the camera, feed events into the index, masks on frames before
// the brain, viewers from room events, feeds restarted and stopped.
import jpeg from "jpeg-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi, type SenseplaneApi } from "./index.js";
import type { ApiBus } from "./indexer.js";
import { createTestDatabase } from "./testdb.js";
import { fakeMediaPlane } from "./testkit.js";

describe("media callbacks", () => {
  let api: SenseplaneApi;
  let drop: () => Promise<void>;
  let key: string;
  let accountId: string;
  const plane = fakeMediaPlane();
  const published: { kind: string; source: string; meta: Record<string, unknown>; data: Buffer }[] = [];
  const released: string[] = [];
  const bus = {
    async putSourceConfig() {},
    async putWatch() {},
    async request() { return {} as never; },
    async latestSnapshot() { return undefined; },
    async close() {},
    async publishMedia(_a: string, s: string, kind: string, meta: Record<string, unknown>, data: Buffer) {
      published.push({ kind, source: s, meta, data });
      return true;
    },
    balancer: { async release(k: string) { released.push(k); } },
    onSourceChanged() {},
  } as unknown as ApiBus;

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    api = await createApi({
      database: t.appUrl, logger: false, workers: false, sweepIntervalSeconds: 0, bus,
      captureUrl: "https://console.test/capture.html", apiPublicUrl: "https://api.test",
      media: { control: plane.client },
      storage: { endpoint: "http://s3.test:9000", region: "us-east-1", bucket: "senseplane", accessKeyId: "a", secretAccessKey: "b", forcePathStyle: true },
    });
    accountId = (await api.data.accounts.create("Cb")).id;
    key = (await api.data.withAccount(accountId, (s) => s.apiKeys.create("t"))).key;
  });
  afterAll(async () => {
    await api?.close();
    await drop?.();
  });

  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    api.public.inject({ method, url, payload: payload as object, headers: { authorization: `Bearer ${key}` } });
  const cb = (token: string, payload: unknown) =>
    api.public.inject({ method: "POST", url: "/internal/media/callbacks", payload: payload as object, headers: { authorization: `Bearer ${token}` } });

  async function camera(name: string) {
    const src = (await call("POST", "/v1/sources", { name, type: "browser" })).json();
    const ticket = new URLSearchParams(new URL(src.ingest.capture_url).hash.slice(1)).get("t");
    expect((await api.public.inject({ method: "POST", url: "/v1/capture/join", payload: { ticket } })).statusCode).toBe(200);
    const feed = plane.feeds(src.id).at(-1)!;
    return {
      id: src.id as string,
      sessionId: String(feed.body.sessionId),
      feedToken: (feed.body.callback as { token: string }).token,
      roomToken: plane.rooms.get(`sp-${src.id}`)!.input.callback!.token,
    };
  }
  const feedEvent = (c: { sessionId: string; id: string }, event: string, data: Record<string, unknown>) =>
    ({ event, sentAt: new Date().toISOString(), sessionId: c.sessionId, room: `sp-${c.id}`, idempotencyKey: `${event}:${Math.random()}`, data: { account_id: "spoofed", source_id: "spoofed", ...data } });

  it("needs a callback token, and keeps each token to its own camera and feed", async () => {
    const a = await camera("A");
    const b = await camera("B");
    expect((await cb("nope", { event: "source.online" })).statusCode).toBe(401);
    expect((await cb(a.feedToken, feedEvent(b, "source.online", {}))).statusCode).toBe(403);
    expect((await cb(a.roomToken, feedEvent(a, "source.online", {}))).statusCode).toBe(403);
    expect((await cb(a.roomToken, { roomId: `sp-${b.id}`, event: "participant.joined", at: new Date().toISOString(), idempotencyKey: "x", data: {} })).statusCode).toBe(403);
  });

  it("presigns PUTs only under the camera's own prefix", async () => {
    const c = await camera("Upload");
    const ok = await cb(c.feedToken, { op: "upload_url", sessionId: c.sessionId, room: `sp-${c.id}`, key: `raw/${accountId}/${c.id}/2026/10/17/1.m4s`, content_type: "video/iso.segment", bytes: 10 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().url).toMatch(new RegExp(`^http://s3.test:9000/senseplane/raw/${accountId}/${c.id}/2026/10/17/1.m4s\\?.*X-Amz-Signature=`));
    expect((await cb(c.feedToken, { op: "upload_url", key: `raw/${accountId}/other/1.m4s`, content_type: "video/iso.segment", bytes: 1 })).statusCode).toBe(403);
    expect((await cb(c.feedToken, { op: "upload_url", key: `raw/${accountId}/${c.id}/../x`, content_type: "video/mp4", bytes: 1 })).statusCode).toBe(403);
    expect((await cb(c.feedToken, { op: "upload_url", key: `raw/${accountId}/${c.id}/x.exe`, content_type: "text/html", bytes: 1 })).statusCode).toBe(400);
    expect((await cb(c.feedToken, { op: "credentials" })).statusCode).toBe(400);
  });

  it("indexes feed events with the token's account and source, idempotently", async () => {
    const c = await camera("Index");
    const at = new Date().toISOString();
    expect((await cb(c.feedToken, feedEvent(c, "source.online", { at, codecs: ["h264"], producer_id: "p" }))).statusCode).toBe(200);
    expect((await call("GET", `/v1/sources/${c.id}`)).json().status).toBe("online");
    const seg = { key: `raw/${accountId}/${c.id}/2026/10/17/123.m4s`, init_key: `raw/${accountId}/${c.id}/init/${c.sessionId}.mp4`, start: at, duration_ms: 6000, bytes: 1000, codec: "h264", width: 640, height: 360 };
    await cb(c.feedToken, feedEvent(c, "segment.written", seg));
    await cb(c.feedToken, feedEvent(c, "segment.written", seg));
    const segs = await api.data.withAccount(accountId, (s) => s.db.selectFrom("segments").select("key").where("source_id", "=", c.id).execute());
    expect(segs.map((s) => s.key)).toEqual([seg.key]);
    // A late, retried online after an offline does not bring it back.
    await new Promise((r) => setTimeout(r, 20));
    await cb(c.feedToken, feedEvent(c, "source.offline", { at: new Date().toISOString(), reason: "publisher_left" }));
    expect(released).toContain(`${accountId}.${c.id}`);
    await cb(c.feedToken, feedEvent(c, "source.online", { at, codecs: ["h264"] }));
    expect((await call("GET", `/v1/sources/${c.id}`)).json().status).toBe("offline");
  });

  it("marks a camera offline when it leaves its room, but not when a newer connection replaced it", async () => {
    const c = await camera("Leaves");
    const room = (event: string, data: Record<string, unknown>) =>
      cb(c.roomToken, { roomId: `sp-${c.id}`, event, at: new Date().toISOString(), idempotencyKey: `${event}:${Math.random()}`, data });
    await cb(c.feedToken, feedEvent(c, "source.online", { at: new Date().toISOString(), codecs: ["h264"] }));
    await new Promise((r) => setTimeout(r, 20));
    expect((await room("participant.left", { identity: `${c.id}:capture`, kind: "human", reason: "replaced" })).statusCode).toBe(200);
    expect((await call("GET", `/v1/sources/${c.id}`)).json().status).toBe("online");
    await room("participant.left", { identity: `${c.id}:capture`, kind: "human", reason: "socket_closed" });
    expect((await call("GET", `/v1/sources/${c.id}`)).json().status).toBe("offline");
  });

  it("tells a camera above its resolution limit why it was cut off", async () => {
    const c = await camera("Big");
    await cb(c.feedToken, feedEvent(c, "resolution_rejected", { at: new Date().toISOString(), width: 1920, height: 1080, max_resolution: "720p", identity: `${c.id}:capture` }));
    expect(plane.removed).toContainEqual({ room: `sp-${c.id}`, identity: `${c.id}:capture`, reason: "resolution_not_in_plan" });
  });

  it("blacks out privacy masks on frames before they reach the brain", async () => {
    const c = await camera("Masked");
    // Mask the left half.
    expect((await call("PATCH", `/v1/sources/${c.id}`, { privacy_masks: [[[0, 0], [0.5, 0], [0.5, 1], [0, 1]]] })).statusCode).toBe(200);
    const white = jpeg.encode({ width: 640, height: 360, data: Buffer.alloc(640 * 360 * 4, 255) }, 90).data;
    const form = new FormData();
    const meta = { event: "frames", sentAt: new Date().toISOString(), sessionId: c.sessionId, room: `sp-${c.id}`, idempotencyKey: "frames:1",
      data: { frames: [{ part: "frame0", captured_at: new Date().toISOString(), width: 640, height: 360, format: "jpeg" }], audio: { part: "audio", captured_at: new Date().toISOString(), sample_rate: 16000, samples: 16000, format: "f32le_mono" } } };
    form.append("meta", new Blob([JSON.stringify(meta)], { type: "application/json" }));
    form.append("frame0", new Blob([white], { type: "image/jpeg" }));
    form.append("audio", new Blob([new Uint8Array(64000)], { type: "application/octet-stream" }));
    const req = new Request("http://x/", { method: "POST", body: form });
    const r = await api.public.inject({
      method: "POST", url: "/internal/media/callbacks", payload: Buffer.from(await req.arrayBuffer()),
      headers: { authorization: `Bearer ${c.feedToken}`, "content-type": req.headers.get("content-type")! },
    });
    expect(r.statusCode).toBe(200);
    const frame = published.find((p) => p.source === c.id && p.kind === "frame")!;
    expect(frame.meta).toMatchObject({ width: 640, height: 360, format: "jpeg", masked: true });
    const img = jpeg.decode(frame.data, { useTArray: true });
    const px = (x: number, y: number) => img.data[(y * 640 + x) * 4]!;
    expect(px(100, 180)).toBeLessThan(20); // masked
    expect(px(540, 180)).toBeGreaterThan(235); // untouched
    expect(published.find((p) => p.source === c.id && p.kind === "audio")!.data.length).toBe(64000);
  });

  it("joins and ends viewers from room events, and restarts a feed that ended while the camera is on", async () => {
    const c = await camera("Viewers");
    plane.publish(c.id);
    const live = (await call("POST", `/v1/sources/${c.id}/live`)).json();
    const ev = (event: string, data: Record<string, unknown>) => cb(c.roomToken, { roomId: `sp-${c.id}`, event, at: new Date().toISOString(), idempotencyKey: `${event}:${live.session_id}`, data });
    await ev("participant.joined", { identity: `${c.id}:viewer:${live.session_id}`, kind: "human", sessionId: "s1" });
    const row = () => api.data.withAccount(accountId, (s) => s.db.selectFrom("live_sessions").selectAll().where("id", "=", live.session_id).executeTakeFirstOrThrow());
    expect((await row()).joined_at).not.toBeNull();
    await ev("participant.left", { identity: `${c.id}:viewer:${live.session_id}`, kind: "human", sessionId: "s1", reason: "socket_closed" });
    expect((await row()).end_reason).toBe("socket_closed");

    await api.data.withAccount(accountId, (s) => s.db.updateTable("sources").set({ status: "online" }).where("id", "=", c.id).execute());
    const before = plane.feeds(c.id).length;
    expect((await cb(c.feedToken, { event: "egress.session.ended", sentAt: new Date().toISOString(), session: { sessionId: c.sessionId, status: "finished" } })).statusCode).toBe(200);
    expect(plane.feeds(c.id).length).toBe(before + 1);
  });
});
