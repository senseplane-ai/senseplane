// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Dev and CI only (MEDIA_DEV_REPLAY=1): plays an H.264 fixture into a room as
// the participant a join token names, so recording and perception can be
// tested without a camera. The token goes through the same join gate as a
// browser's; only the media comes from a local ffmpeg over a plain transport
// instead of WebRTC. Stream copy only; h264_mp4toannexb puts SPS/PPS in-band
// before keyframes, as browsers do.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";
import type { RoomManager } from "./rooms.js";
import { type JoinDeps, admit } from "./signalling.js";

const SSRC = 22222222;
const PT = 102;
const AUDIO_SSRC = 33333333;
const AUDIO_PT = 100;

/** True if the file has an Opus audio stream (replayed alongside the video). */
export function hasOpusAudio(ffmpegPath: string, file: string): boolean {
  try {
    const ffprobe = ffmpegPath.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
    return execFileSync(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", file]).toString().trim() === "opus";
  } catch {
    return false;
  }
}

export function registerReplay(app: FastifyInstance, deps: JoinDeps & { rooms: RoomManager; ffmpegPath: string }) {
  const running = new Map<string, { ff: ChildProcess; leave: (reason: string) => Promise<void> }>();

  app.post<{ Body: { token?: string; file?: string; audio?: boolean } }>("/dev/replay", async (req, reply) => {
    const { token, file } = req.body ?? {};
    if (typeof file !== "string" || !file) return reply.code(400).send({ error: "file is required" });
    let joined: Awaited<ReturnType<typeof admit>>;
    let ff: ChildProcess | undefined;
    try {
      joined = await admit(deps, token, { send: () => undefined, close: () => ff?.kill("SIGTERM") });
    } catch (err) {
      return reply.code(401).send({ error: (err as { code?: string }).code ?? "unauthorized" });
    }
    const { participant: p, claims } = joined;
    const key = `${claims.room}|${claims.identity}`;
    running.get(key)?.ff.kill("SIGTERM");
    const router = await p.room.acquireRouter();
    const video = await router.createPlainTransport({ listenInfo: { protocol: "udp", ip: "127.0.0.1" }, rtcpMux: true, comedia: true });
    deps.rooms.attachTransport(p, video, "send");
    await deps.rooms.produce(p, video.id, "video", {
      codecs: [{ mimeType: "video/H264", payloadType: PT, clockRate: 90000, parameters: { "packetization-mode": 1, "profile-level-id": "42e01f" } }],
      encodings: [{ ssrc: SSRC }],
    }, { source: "camera" });
    const extra: string[] = [];
    const g = claims.grants;
    if (req.body.audio !== false && (!g.publishKinds || g.publishKinds.includes("audio")) && hasOpusAudio(deps.ffmpegPath, file)) {
      const audio = await router.createPlainTransport({ listenInfo: { protocol: "udp", ip: "127.0.0.1" }, rtcpMux: true, comedia: true });
      deps.rooms.attachTransport(p, audio, "send");
      await deps.rooms.produce(p, audio.id, "audio", { codecs: [{ mimeType: "audio/opus", payloadType: AUDIO_PT, clockRate: 48000, channels: 2 }], encodings: [{ ssrc: AUDIO_SSRC }] }, { source: "microphone" });
      extra.push("-map", "0:a:0", "-c:a", "copy", "-f", "rtp", "-ssrc", String(AUDIO_SSRC), "-payload_type", String(AUDIO_PT), `rtp://127.0.0.1:${audio.tuple.localPort}?pkt_size=1200`);
    }
    ff = spawn(deps.ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-re", "-stream_loop", "-1", "-i", file, "-map", "0:v:0", "-c:v", "copy", "-bsf:v", "h264_mp4toannexb",
      "-f", "rtp", "-ssrc", String(SSRC), "-payload_type", String(PT), `rtp://127.0.0.1:${video.tuple.localPort}?pkt_size=1200`, ...extra,
    ], { stdio: "ignore" });
    running.set(key, { ff, leave: (reason) => p.leave(reason) });
    return { started: true, room: claims.room, identity: claims.identity };
  });

  // abrupt: the publisher vanishes first (like a closed browser tab), then the session ends.
  app.post<{ Body: { room?: string; identity?: string; abrupt?: boolean } }>("/dev/replay/stop", async (req) => {
    const key = `${req.body?.room}|${req.body?.identity}`;
    const r = running.get(key);
    if (!r) return { stopped: false };
    running.delete(key);
    if (req.body.abrupt) {
      r.ff.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 1500));
      await r.leave("left");
    } else {
      await r.leave("left");
      r.ff.kill("SIGTERM");
    }
    return { stopped: true };
  });

  return {
    stopAll() {
      for (const r of running.values()) r.ff.kill("SIGTERM");
      running.clear();
    },
  };
}
