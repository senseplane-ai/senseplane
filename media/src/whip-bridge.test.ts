// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The bridge path, end to end with real WebRTC: the bridge's Go WHIP client
// (bridge/internal/whip, pion) pushes H.264, unchanged, and a camera's G.711
// sound, to the WHIP ingress;
// the feed egress records it. With GO2RTC_PATH set the camera is an RTSP
// stream served by go2rtc, as on a bridge; otherwise the fixture is piped in
// directly. Needs Go (builds bridge/cmd/whip-push) and ffmpeg; skipped otherwise.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { callbackServer, control, egressGrants, joinToken, publisherGrants, startMedia, until, whipToken } from "./testkit.js";

const GO2RTC = process.env.GO2RTC_PATH;
const FIXTURE = new URL("../../fixtures/testsrc-h264-640x360-20s.mp4", import.meta.url).pathname;
const SRC = "src_bridge_cam";
const ROOM = `sp-${SRC}`;
const has = (bin: string, arg = "-version") => {
  try {
    execFileSync(bin, [arg], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const ready = has("go", "version") && has("ffmpeg");
if (!ready) console.warn("[media] skipping the WHIP bridge test: it needs Go and ffmpeg on PATH.");

describe.skipIf(!ready)("bridge path: WHIP (pion) → room → feed egress", () => {
  const procs: ChildProcess[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const p of procs) p.kill("SIGTERM");
    for (const c of closers) await c();
  });

  /** Relays the fixture as a bridge camera (with a G.711 tone as its sound when `tone`) and returns the first recorded segment. */
  async function relay(opts: { tone?: "pcma" | "pcmu" } = {}) {
    const root = mkdtempSync(join(tmpdir(), "sp-bridge-"));
    const hooks = await callbackServer({ authorize: () => ({ status: 200, body: { token: joinToken({ room: ROOM, identity: `${SRC}:whip`, kind: "ingress", grants: publisherGrants(Boolean(opts.tone)) }) } }) });
    const media = await startMedia({ listenIp: "127.0.0.1", announcedAddress: "127.0.0.1" });
    closers.push(() => media.close(), () => hooks.close());
    await control(media.base, "POST", "/control/rooms", { roomId: ROOM, options: { liveness: "any", codecs: ["h264", "opus", "g711"] } });
    const started = await control(media.base, "POST", "/control/egress", {
      sessionId: "feed-bridge", room: ROOM,
      joinToken: joinToken({ room: ROOM, identity: `${SRC}:feed`, kind: "egress", transport: "pipe", grants: egressGrants() }),
      sinks: [{ kind: "segments", keyPrefix: `raw/acc/${SRC}/`, segmentSeconds: 2, destination: { type: "presign-callback" } }],
      callback: { url: `${hooks.base}/feed`, token: "cb" },
    });
    expect(started.status).toBe(201);

    let source: string[];
    if (GO2RTC) {
      const rtspPort = 48000 + Math.floor(Math.random() * 1000);
      const cfg = join(root, "go2rtc.yaml");
      writeFileSync(cfg, ["api:", '  listen: ""', "rtsp:", `  listen: "127.0.0.1:${rtspPort}"`, "webrtc:", '  listen: ""', "streams:", `  cam: ffmpeg:${FIXTURE}#video=copy`, ""].join("\n"));
      procs.push(spawn(GO2RTC, ["-config", cfg], { stdio: "ignore" }));
      await new Promise((r) => setTimeout(r, 2000));
      source = ["-rtsp_transport", "tcp", "-i", `rtsp://127.0.0.1:${rtspPort}/cam`];
    } else {
      source = ["-re", "-i", FIXTURE];
    }
    const bin = join(root, "whip-push");
    execFileSync("go", ["build", "-o", bin, "./cmd/whip-push"], { cwd: new URL("../../bridge", import.meta.url).pathname });
    // ffmpeg is only glue: the camera's own H.264 as Annex B, SPS/PPS repeated before keyframes as cameras do.
    const pull = spawn("ffmpeg", ["-v", "error", ...source, "-c", "copy", "-bsf:v", "h264_mp4toannexb,dump_extra", "-f", "h264", "-"], { stdio: ["ignore", "pipe", "ignore"] });
    const push = spawn(bin, ["-endpoint", `${media.base}/whip/${SRC}`, "-fps", "15", ...(opts.tone ? ["-tone", opts.tone] : [])], { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, WHIP_TOKEN: whipToken(ROOM, `${hooks.base}/authorize`) } });
    pull.stdout!.pipe(push.stdin!);
    let pushErr = "";
    push.stderr!.on("data", (d) => (pushErr += d.toString()));
    procs.push(pull, push);

    const segs = () => hooks.events("segment.written").map((e) => e.data as { key: string; init_key: string; start: string; duration_ms: number });
    await until(`3 segments (whip-push: ${pushErr.slice(0, 400)})`, () => segs().length >= 3, 45_000);
    const recorded = segs()[1]!; // past the first, so the sound has settled in
    push.kill("SIGINT"); // DELETEs the WHIP session
    pull.kill("SIGTERM");
    await until("source.offline", () => hooks.events("source.offline").length >= 1, 20_000);
    const s = segs();
    for (let i = 1; i < s.length; i++) {
      if (s[i]!.init_key !== s[i - 1]!.init_key) continue;
      const gap = Date.parse(s[i]!.start) - (Date.parse(s[i - 1]!.start) + s[i - 1]!.duration_ms);
      expect(Math.abs(gap)).toBeLessThan(150);
    }
    expect(hooks.events("source.online")[0]!.data).toMatchObject({ identity: `${SRC}:whip` });
    const file = join(root, "probe.mp4");
    writeFileSync(file, Buffer.concat([hooks.objects.get(recorded.init_key)!, hooks.objects.get(recorded.key)!]));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]).toString()) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[] };
    return { file, probe, online: hooks.events("source.online")[0]!.data as { codecs: string[] } };
  }

  it("records a camera relayed over WHIP without re-encoding", async () => {
    const { probe, online } = await relay();
    expect(probe.streams.find((x) => x.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 640, height: 360 });
    expect(probe.streams.some((x) => x.codec_type === "audio")).toBe(false);
    expect(online.codecs).toEqual(["h264"]);
  }, 90_000);

  it("records a camera's G.711 sound as AAC, and it is not silence", async () => {
    const { file, probe, online } = await relay({ tone: "pcma" });
    expect(probe.streams.find((x) => x.codec_type === "video")).toMatchObject({ codec_name: "h264", width: 640, height: 360 });
    expect(probe.streams.find((x) => x.codec_type === "audio")).toMatchObject({ codec_name: "aac" });
    expect(online.codecs).toEqual(["h264", "pcma"]);
    // The tone is about -12 dBFS; silence (or garbage) would not be.
    const vol = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(vol)?.[1]);
    expect(mean).toBeGreaterThan(-25);
  }, 90_000);
});
