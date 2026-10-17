// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Spike (ADR 0014): H.264 from a browser → mediasoup → PlainTransport → ffmpeg
// stream copy → fMP4 segments. Run: pnpm spike [seconds]
// Uses local Chrome with a fake camera. Writes spike/out/.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { build } from "esbuild";
import * as mediasoup from "mediasoup";
import puppeteer from "puppeteer-core";

const SECONDS = Number(process.argv[2] ?? 45);
const OUT = join(import.meta.dirname, "out");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const RTP_PORT = 50604;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const bundle = await build({
  entryPoints: [join(import.meta.dirname, "client.ts")],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
const page = `<!doctype html><meta charset="utf-8"><body>loading<script type="module">${bundle.outputFiles[0]!.text}</script>`;

const worker = await mediasoup.createWorker({ logLevel: "warn" });
const router = await worker.createRouter({
  mediaCodecs: [
    {
      kind: "video",
      mimeType: "video/H264",
      clockRate: 90000,
      parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 },
    },
  ],
});
let webrtc: mediasoup.types.WebRtcTransport | undefined;
let ffmpeg: ReturnType<typeof spawn> | undefined;
let keyframeTimer: NodeJS.Timeout | undefined;
const t0 = Date.now();
let firstProduceMs = 0;

async function startRecorder(producer: mediasoup.types.Producer) {
  const plain = await router.createPlainTransport({ listenInfo: { protocol: "udp", ip: "127.0.0.1" }, rtcpMux: false, comedia: false });
  await plain.connect({ ip: "127.0.0.1", port: RTP_PORT, rtcpPort: RTP_PORT + 1 });
  const consumer = await plain.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities, paused: true });
  const codec = consumer.rtpParameters.codecs[0]!;
  const fmtp = Object.entries(codec.parameters ?? {}).map(([k, v]) => `${k}=${v}`).join(";");
  const sdp = [
    "v=0",
    "o=- 0 0 IN IP4 127.0.0.1",
    "s=senseplane-spike",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=video ${RTP_PORT} RTP/AVP ${codec.payloadType}`,
    `a=rtcp:${RTP_PORT + 1}`,
    `a=rtpmap:${codec.payloadType} H264/90000`,
    `a=fmtp:${codec.payloadType} ${fmtp}`,
    "a=recvonly",
    "",
  ].join("\n");
  writeFileSync(join(OUT, "in.sdp"), sdp);
  ffmpeg = spawn(
    FFMPEG,
    [
      "-hide_banner", "-loglevel", "info", "-protocol_whitelist", "file,udp,rtp",
      "-fflags", "+genpts", "-i", join(OUT, "in.sdp"),
      "-map", "0:v:0", "-c:v", "copy",
      "-f", "hls", "-hls_time", "6", "-hls_segment_type", "fmp4", "-hls_list_size", "0",
      "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", join(OUT, "seg_%05d.m4s"),
      join(OUT, "index.m3u8"),
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let log = "";
  ffmpeg.stderr!.on("data", (d) => (log += d));
  ffmpeg.on("exit", () => writeFileSync(join(OUT, "ffmpeg.log"), log));
  await new Promise((r) => setTimeout(r, 1000));
  await consumer.resume();
  await consumer.requestKeyFrame();
  keyframeTimer = setInterval(() => void consumer.requestKeyFrame(), 2000);
}

const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const json = body ? JSON.parse(body) : {};
  const send = (o: unknown) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(o));
  };
  if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    return res.end(page);
  }
  if (req.url === "/rtp-capabilities") return send(router.rtpCapabilities);
  if (req.url === "/transport") {
    webrtc = await router.createWebRtcTransport({ listenInfos: [{ protocol: "udp", ip: "127.0.0.1" }] });
    return send({ id: webrtc.id, iceParameters: webrtc.iceParameters, iceCandidates: webrtc.iceCandidates, dtlsParameters: webrtc.dtlsParameters });
  }
  if (req.url === "/connect") {
    await webrtc!.connect({ dtlsParameters: json.dtlsParameters });
    return send({});
  }
  if (req.url === "/produce") {
    const producer = await webrtc!.produce({ kind: json.kind, rtpParameters: json.rtpParameters });
    firstProduceMs = Date.now() - t0;
    await startRecorder(producer);
    return send({ id: producer.id });
  }
  res.statusCode = 404;
  res.end();
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-sandbox"],
});
const tab = await browser.newPage();
await tab.goto(`http://127.0.0.1:${port}/`);
await tab.waitForFunction("window.spikeReady || window.spikeError", { timeout: 20_000 });
const err = await tab.evaluate("window.spikeError");
if (err) throw new Error(`browser: ${err}`);

// Sample ffmpeg CPU while recording.
const cpu: number[] = [];
const sampler = setInterval(() => {
  try {
    cpu.push(Number(execFileSync("ps", ["-o", "%cpu=", "-p", String(ffmpeg!.pid)]).toString().trim()));
  } catch { /* exited */ }
}, 2000);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(sampler);
clearInterval(keyframeTimer);
// Stop ffmpeg while packets still flow (a blocked UDP read ignores "q"), then the browser.
const exited = new Promise((r) => ffmpeg!.once("exit", r));
ffmpeg!.stdin!.write("q");
const killTimer = setTimeout(() => ffmpeg!.kill("SIGKILL"), 10_000);
await exited;
clearTimeout(killTimer);
await browser.close();
worker.close();
server.close();

// Analyse output.
const segs = readdirSync(OUT).filter((f) => f.endsWith(".m4s")).sort();
const tmp = join(OUT, "probe.mp4");
const probeFile = (files: string[]) => {
  writeFileSync(tmp, Buffer.concat(files.map((f) => readFileSync(join(OUT, f)))));
  return JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-select_streams", "v:0", "-of", "json", tmp]).toString(),
  );
};
// Segment durations as written by the segmenter (#EXTINF).
const durations = [...readFileSync(join(OUT, "index.m3u8"), "utf8").matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
const all = probeFile(["init.mp4", ...segs]);
const probe = all.streams[0];
rmSync(tmp);
const ffLog = readFileSync(join(OUT, "ffmpeg.log"), "utf8");
const result = {
  recordedSeconds: SECONDS,
  firstProduceMs,
  segments: segs.length,
  segmentSecondsMin: Math.min(...durations).toFixed(2),
  segmentSecondsMax: Math.max(...durations).toFixed(2),
  segmentSecondsTotal: durations.reduce((a, b) => a + b, 0).toFixed(2),
  avgSegmentKB: Math.round(segs.reduce((a, s) => a + statSync(join(OUT, s)).size, 0) / segs.length / 1024),
  codec: `${probe.codec_name} ${probe.profile} ${probe.width}x${probe.height}`,
  frameRate: probe.avg_frame_rate,
  playableSeconds: Number(all.format.duration).toFixed(2),
  streamCopy: /Stream #0:0 -> #0:0 \(copy\)/.test(ffLog),
  ffmpegCpuPercentAvg: cpu.length ? (cpu.reduce((a, b) => a + b, 0) / cpu.length).toFixed(1) : "n/a",
};
writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
