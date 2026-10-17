// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The bridge path, end to end with real WebRTC: the bridge's Go WHIP client
// (bridge/internal/whip, pion) pushes H.264, unchanged, to the WHIP ingress;
// the feed egress records it. With GO2RTC_PATH set the camera is an RTSP
// stream served by go2rtc, as on a bridge; otherwise the fixture is piped in
// directly. Needs Go (builds bridge/cmd/whip-push) and ffmpeg; skipped otherwise.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
  let media: Awaited<ReturnType<typeof startMedia>> | undefined;
  let hooks: Awaited<ReturnType<typeof callbackServer>> | undefined;
  afterAll(async () => {
    for (const p of procs) p.kill("SIGTERM");
    await media?.close();
    await hooks?.close();
  });

  it("records a camera relayed over WHIP without re-encoding", async () => {
    const root = mkdtempSync(join(tmpdir(), "sp-bridge-"));
    hooks = await callbackServer({ authorize: () => ({ status: 200, body: { token: joinToken({ room: ROOM, identity: `${SRC}:whip`, kind: "ingress", grants: publisherGrants() }) } }) });
    media = await startMedia({ listenIp: "127.0.0.1", announcedAddress: "127.0.0.1" });
    await control(media.base, "POST", "/control/rooms", { roomId: ROOM, options: { liveness: "any", codecs: ["h264", "opus"] } });
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
    const push = spawn(bin, ["-endpoint", `${media.base}/whip/${SRC}`, "-fps", "15"], { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, WHIP_TOKEN: whipToken(ROOM, `${hooks.base}/authorize`) } });
    pull.stdout!.pipe(push.stdin!);
    let pushErr = "";
    push.stderr!.on("data", (d) => (pushErr += d.toString()));
    procs.push(pull, push);

    const segs = () => hooks!.events("segment.written").map((e) => e.data as { key: string; init_key: string; start: string; duration_ms: number });
    await until(`3 segments (whip-push: ${pushErr.slice(0, 400)})`, () => segs().length >= 3, 45_000);
    push.kill("SIGINT"); // DELETEs the WHIP session
    pull.kill("SIGTERM");
    await until("source.offline", () => hooks!.events("source.offline").length >= 1, 20_000);
    const s = segs();
    for (let i = 1; i < s.length; i++) {
      if (s[i]!.init_key !== s[i - 1]!.init_key) continue;
      const gap = Date.parse(s[i]!.start) - (Date.parse(s[i - 1]!.start) + s[i - 1]!.duration_ms);
      expect(Math.abs(gap)).toBeLessThan(150);
    }
    expect(hooks.events("source.online")[0]!.data).toMatchObject({ identity: `${SRC}:whip` });
    const file = join(root, "probe.mp4");
    writeFileSync(file, Buffer.concat([hooks.objects.get(s[0]!.init_key)!, hooks.objects.get(s[0]!.key)!]));
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]).toString());
    expect(probe.streams[0]).toMatchObject({ codec_name: "h264", width: 640, height: 360 });
  }, 90_000);
});
