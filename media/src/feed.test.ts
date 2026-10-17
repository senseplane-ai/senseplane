// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The feed egress end to end: a replayed H.264 camera → the room → the egress
// (joined over signalling, plain RTP) → ~2 s fMP4 segments PUT to presigned
// URLs on a mock callback server, feed events, and frames batches. Needs
// ffmpeg/ffprobe on PATH; skipped with a note otherwise. Waits are on
// events, not fixed sleeps.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callbackServer, control, egressGrants, joinToken, publisherGrants, startMedia, until } from "./testkit.js";

const FIXTURE = new URL("../../fixtures/testsrc-h264-640x360-20s.mp4", import.meta.url).pathname;
const ffmpegUp = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
if (!ffmpegUp) console.warn("[media] skipping the feed egress tests: ffmpeg/ffprobe aren't on PATH.");

type Media = Awaited<ReturnType<typeof startMedia>>;
type Hooks = Awaited<ReturnType<typeof callbackServer>>;

describe.skipIf(!ffmpegUp)("feed egress", () => {
  let media: Media;
  let hooks: Hooks;
  let n = 0;

  beforeAll(async () => {
    media = await startMedia({ devReplay: true });
    hooks = await callbackServer();
  });
  afterAll(async () => {
    await media?.close();
    await hooks?.close();
  });

  async function camera(opts: { maxResolution?: "720p" | "1080p"; frames?: boolean } = {}) {
    const src = `src_feed${process.pid}${++n}`;
    const roomId = `sp-${src}`;
    await control(media.base, "POST", "/control/rooms", { roomId, options: { liveness: "any", codecs: ["h264", "opus"] } });
    const sessionId = `feed-${src}`;
    const r = await control(media.base, "POST", "/control/egress", {
      sessionId, room: roomId,
      joinToken: joinToken({ room: roomId, identity: `${src}:feed`, kind: "egress", transport: "pipe", grants: egressGrants() }),
      sinks: [
        { kind: "segments", keyPrefix: `raw/acc/${src}/`, segmentSeconds: 2, destination: { type: "presign-callback" }, metadata: { account_id: "acc", source_id: src }, ...(opts.maxResolution ? { maxResolution: opts.maxResolution } : {}) },
        ...(opts.frames === false ? [] : [{ kind: "frames", fps: 5, metadata: { account_id: "acc", source_id: src } }]),
      ],
      callback: { url: `${hooks.base}/feed/${src}`, token: `cb-${src}` },
    });
    expect([200, 201, 202]).toContain(r.status);
    expect(r.body).toMatchObject({ sessionId, room: roomId });
    return { src, roomId, sessionId };
  }
  const publish = async (roomId: string, src: string, file = FIXTURE) => {
    const r = await fetch(`${media.base}/dev/replay`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ file, token: joinToken({ room: roomId, identity: `${src}:capture`, grants: publisherGrants() }) }),
    });
    expect(r.status).toBe(200);
  };
  const unpublish = (roomId: string, src: string, abrupt = false) =>
    fetch(`${media.base}/dev/replay/stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ room: roomId, identity: `${src}:capture`, abrupt }) });
  const feed = (src: string) => hooks.received.filter((r) => r.path === `/feed/${src}`);
  const events = (src: string, name: string) => feed(src).filter((r) => r.json?.event === name).map((r) => r.json!);

  it("records ~2 s segments into presigned PUTs, announces them, and posts frames", async () => {
    const { src, roomId, sessionId } = await camera();
    expect((await control(media.base, "GET", `/control/egress/${sessionId}`)).body.status).toBe("waiting");
    // Idempotent: the same sessionId answers the running session.
    const again = await control(media.base, "POST", "/control/egress", { sessionId, room: roomId, joinToken: "unused", sinks: [{ kind: "frames" }], callback: { url: `${hooks.base}/x`, token: "x" } });
    expect(again.status).toBe(200);
    await publish(roomId, src);
    await until("4 segments", () => events(src, "segment.written").length >= 4, 60_000);
    await until("frames", () => events(src, "frames").length >= 3);
    const t0 = Date.now();
    await unpublish(roomId, src);
    await until("source.offline", () => events(src, "source.offline").length >= 1, 20_000);
    expect(Date.now() - t0).toBeLessThan(15_000);

    const seq = feed(src).filter((r) => r.json?.event && r.json.event !== "frames").map((r) => r.json!.event);
    expect(seq[0]).toBe("source.online");
    expect(seq.at(-1)).toBe("source.offline");
    const online = events(src, "source.online")[0]!;
    expect(online).toMatchObject({ sessionId, room: roomId, data: { account_id: "acc", source_id: src, codecs: ["h264"], identity: `${src}:capture` } });
    expect(feed(src)[0]!.auth).toBe(`Bearer cb-${src}`);

    // upload_url was asked once per object, the init first; every object landed in the "bucket".
    const asks = feed(src).filter((r) => r.json?.op === "upload_url").map((r) => r.json!);
    expect(asks[0]).toMatchObject({ key: `raw/acc/${src}/init/${sessionId}.mp4`, content_type: "video/mp4", sessionId, room: roomId });
    const segs = events(src, "segment.written").map((e) => e.data as Record<string, unknown>);
    for (const [i, s] of segs.entries()) {
      expect(s.key).toMatch(new RegExp(`^raw/acc/${src}/\\d{4}/\\d{2}/\\d{2}/\\d+\\.m4s$`));
      expect(s).toMatchObject({ init_key: `raw/acc/${src}/init/${sessionId}.mp4`, codec: "h264", width: 640, height: 360, account_id: "acc", source_id: src });
      if (i < segs.length - 1) expect(s.duration_ms).toBeGreaterThan(1000);
      expect(s.duration_ms).toBeLessThan(5000);
      expect(hooks.objects.get(String(s.key))?.length).toBe(s.bytes);
      expect(hooks.contentTypes.get(String(s.key))).toBe("video/iso.segment");
    }
    expect(events(src, "segment.written")[0]!.idempotencyKey).toBe(`segment.written:${segs[0]!.key}`);
    // The first segment with its init is the original H.264, not re-encoded.
    const file = join(mkdtempSync(join(tmpdir(), "sp-probe-")), "a.mp4");
    writeFileSync(file, Buffer.concat([hooks.objects.get(String(segs[0]!.init_key))!, hooks.objects.get(String(segs[0]!.key))!]));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]).toString());
    expect(probe.streams[0]).toMatchObject({ codec_name: "h264", width: 640, height: 360 });

    // Frames: multipart batches of ≤ 5 640x360 JPEGs.
    const batch = feed(src).find((r) => r.json?.event === "frames" && (r.json.data as { frames: unknown[] }).frames.length)!;
    const data = batch.json!.data as { frames: { part: string; width: number; height: number; format: string }[]; source_id: string };
    expect(data.source_id).toBe(src);
    expect(data.frames.length).toBeLessThanOrEqual(5);
    expect(data.frames[0]).toMatchObject({ part: "frame0", width: 640, height: 360, format: "jpeg" });
    const jpeg = Buffer.from(await (batch.form!.get("frame0") as Blob).arrayBuffer());
    expect(jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");

    // A reconnecting camera is a new run of the same session, with a gap.
    await publish(roomId, src);
    await until("second run", () => events(src, "source.online").length >= 2, 30_000);
    await until("gap", () => events(src, "recording.gap").length >= 1);
    expect(events(src, "recording.gap")[0]!.data).toMatchObject({ reason: "publisher_reconnected" });
    await until("segment of run 2", () => events(src, "segment.written").some((e) => String((e.data as { init_key: string }).init_key).endsWith(`${sessionId}-2.mp4`)), 30_000);

    // Stopping ends the run, then the session, and says so.
    const stopped = await control(media.base, "DELETE", `/control/egress/${sessionId}`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.status).toBe("finished");
    await until("egress.session.ended", () => feed(src).find((r) => r.json?.event === "egress.session.ended"));
    expect((await control(media.base, "DELETE", `/control/egress/${sessionId}`)).body.status).toBe("finished");
    await unpublish(roomId, src);
  }, 180_000);

  it("keeps the open segment when the publisher vanishes", async () => {
    const { src, roomId } = await camera({ frames: false });
    await publish(roomId, src);
    await until("2 segments", () => events(src, "segment.written").length >= 2, 60_000);
    const before = events(src, "segment.written").length;
    await unpublish(roomId, src, true);
    await until("source.offline", () => events(src, "source.offline").length >= 1, 30_000);
    // The segment that was open when the camera vanished is written too (after the offline, which is announced at once).
    await until("the open segment", () => events(src, "segment.written").length > before, 20_000);
  }, 120_000);

  it("refuses a stream above maxResolution without storing anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sp-1080-"));
    const big = join(dir, "1080p.mp4");
    try {
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=1920x1080:rate=15:duration=6", "-c:v", "libx264", "-profile:v", "baseline", "-g", "15", "-pix_fmt", "yuv420p", big]);
    } catch {
      return; // no H.264 encoder on this machine
    }
    const { src, roomId } = await camera({ maxResolution: "720p" });
    await publish(roomId, src, big);
    await until("resolution_rejected", () => events(src, "resolution_rejected").length >= 1, 30_000);
    expect(events(src, "resolution_rejected")[0]!.data).toMatchObject({ width: 1920, height: 1080, max_resolution: "720p", identity: `${src}:capture` });
    await new Promise((r) => setTimeout(r, 2500));
    expect(feed(src).filter((r) => r.json?.op === "upload_url")).toHaveLength(0);
    expect(events(src, "segment.written")).toHaveLength(0);
    expect(events(src, "frames")).toHaveLength(0);
    await unpublish(roomId, src);
  }, 60_000);
});
