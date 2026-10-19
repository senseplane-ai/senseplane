#!/usr/bin/env node
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Load test for a running Senseplane server (docs/load-test.md): adds fake WHIP
// cameras in steps, looping the fixtures from this machine through the same path
// real cameras use, and measures recording, detection delay and (over SSH) the
// server's CPU, memory and disk. It also watches this machine (CPU, the test's
// own ffmpeg and WHIP processes, upload rate), so a step that fails because the
// sender couldn't keep up says so instead of blaming the server. At the end (also on Ctrl-C) the cameras are
// removed, or paused where the server can't remove cameras yet; their recordings
// then expire with the usual retention.
//
//   SENSEPLANE_API_KEY=sk_... node scripts/load/vm.mjs --api https://cams.example.com \
//     [--steps 5,10,20,40] [--minutes 10] [--warmup 60] [--busy 0.2] [--ssh root@203.0.113.7]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { cpus, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values: o } = parseArgs({
  options: {
    api: { type: "string" }, steps: { type: "string", default: "5,10,20,40" }, minutes: { type: "string", default: "10" },
    warmup: { type: "string", default: "60" }, busy: { type: "string", default: "0.2" }, ssh: { type: "string" },
  },
});
const KEY = process.env.SENSEPLANE_API_KEY ?? "";
if (!o.api || !KEY.startsWith("sk_")) {
  console.error("usage: SENSEPLANE_API_KEY=sk_... node scripts/load/vm.mjs --api https://<your domain> [--steps 5,10,20] [--minutes 10] [--ssh root@<vm>]");
  process.exit(2);
}
const API = o.api.replace(/\/$/, "");
const STEPS = o.steps.split(",").map(Number).filter((n) => n > 0).sort((a, b) => a - b);
const MEASURE_MS = Number(o.minutes) * 60_000;
const WARMUP_MS = Number(o.warmup) * 1000;
const BUSY = Number(o.busy);
// Busy scenes (people, a van, a dog: detection runs often) and a quiet one (an empty view).
const BUSY_CLIPS = ["doorstep-parcel-640x360.mp4", "van-driving-640x360.mp4", "dog-indoors-640x480.mp4"];
const QUIET_CLIP = "night-sky-empty-640x480.mp4";

const log = (...a) => console.log(`[load ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method, headers: { authorization: `Bearer ${KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (r.status === 403 && json?.error?.message?.includes("agent keys")) {
    throw new Error("this is an agent key, which can't add cameras. Make an account key on the server: docker compose exec api sh -c 'set -a && . /secrets/api.env && set +a && node dist/cli.js create-account \"Load test\"'");
  }
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${json?.error?.message ?? ""}`);
  return json;
}
const ssh = (cmd) => (o.ssh ? execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", o.ssh, cmd]).toString() : "");

// The bridge's WHIP client, built once.
const work = mkdtempSync(join(tmpdir(), "senseplane-load-"));
const whipPush = join(work, "whip-push");
execFileSync("go", ["build", "-o", whipPush, "./cmd/whip-push"], { cwd: join(ROOT, "bridge"), stdio: "inherit" });

/** @type {{ id: string; name: string; busy: boolean; clip: string; url: string; token: string; restarts: number; pids?: number[]; stop?: () => void }[]} */
const cameras = [];
let stopping = false;

function push(cam) {
  const ff = spawn("ffmpeg", ["-hide_banner", "-v", "error", "-re", "-stream_loop", "-1", "-i", join(ROOT, "fixtures", cam.clip),
    "-an", "-c", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "h264", "-"]);
  const wp = spawn(whipPush, ["-endpoint", cam.url, "-fps", "15"], { env: { ...process.env, WHIP_TOKEN: cam.token }, stdio: ["pipe", "ignore", "pipe"] });
  ff.stdout.pipe(wp.stdin);
  wp.stdin.on("error", () => undefined);
  let stderr = "";
  wp.stderr.on("data", (d) => (stderr = (stderr + d).slice(-300)));
  wp.on("exit", () => {
    ff.kill();
    if (stopping) return;
    cam.restarts++; // dropped: a sign of trouble, counted per step
    cam.pids = [];
    if (cam.restarts <= 3) log(`${cam.name} disconnected, pushing again:`, stderr.replace(/eyJ[\w.-]+/g, "<token>").trim().split("\n").at(-1));
    setTimeout(() => push(cam), 2000);
  });
  cam.pids = [ff.pid, wp.pid].filter(Boolean);
  cam.stop = () => { wp.kill(); ff.kill(); };
}

async function addCamera(i) {
  // Spread evenly, so every step has the same share of busy cameras (1 in 5 for --busy 0.2).
  const every = BUSY > 0 ? Math.max(1, Math.round(1 / BUSY)) : Infinity;
  const busy = i % every === 0;
  const clip = busy ? BUSY_CLIPS[i % BUSY_CLIPS.length] : QUIET_CLIP;
  const s = await call("POST", "/v1/sources", { name: `load-${String(i + 1).padStart(2, "0")}${busy ? "-busy" : ""}`, type: "whip" });
  const cam = { id: s.id, name: s.name, busy, clip, url: s.ingest.whip_url, token: s.ingest.token, restarts: 0 };
  cameras.push(cam);
  push(cam);
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  for (const c of cameras) c.stop?.();
  log(`removing ${cameras.length} load cameras…`);
  let paused = 0;
  for (const c of cameras) {
    const removed = await call("DELETE", `/v1/sources/${c.id}`).then(() => true, () => false);
    if (!removed && (await call("POST", `/v1/sources/${c.id}/pause`).then(() => true, (e) => (log("could not pause", c.name, e.message), false)))) paused++;
  }
  if (paused) log(`${paused} cameras paused (this server can't remove cameras yet); they record nothing, and their footage expires with retention`);
}
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

function serverSample() {
  if (!o.ssh) return undefined;
  try {
    const rows = ssh("docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'").trim().split("\n");
    return Object.fromEntries(rows.map((r) => {
      const [name, cpu, mem] = r.split("|");
      const svc = name.replace(/^senseplane-server-/, "").replace(/-\d+$/, "");
      const mb = (v) => (/GiB/.test(v) ? parseFloat(v) * 1024 : /MiB/.test(v) ? parseFloat(v) : parseFloat(v) / 1024);
      return [svc, { cpu: parseFloat(cpu), memMb: Math.round(mb(mem.split("/")[0].trim())) }];
    }));
  } catch {
    return undefined;
  }
}
// --- this machine (the sender) ------------------------------------------------------
const CORES = cpus().length;
const cpuTimes = () => cpus().reduce((a, c) => ({ busy: a.busy + c.times.user + c.times.nice + c.times.sys + c.times.irq, all: a.all + c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle }), { busy: 0, all: 0 });
/** Bytes sent on every interface but loopback (macOS netstat, Linux /proc/net/dev); undefined when unknown. */
function bytesSent() {
  try {
    if (platform() === "linux") {
      return execFileSync("cat", ["/proc/net/dev"]).toString().split("\n").slice(2).filter((l) => l.includes(":") && !l.trim().startsWith("lo:"))
        .reduce((a, l) => a + Number(l.split(":")[1].trim().split(/\s+/)[8] ?? 0), 0);
    }
    if (platform() === "darwin") {
      const seen = new Set();
      let total = 0;
      for (const l of execFileSync("netstat", ["-ib"]).toString().split("\n").slice(1)) {
        const f = l.trim().split(/\s+/);
        if (f.length < 10 || f[0].startsWith("lo") || seen.has(f[0])) continue;
        seen.add(f[0]);
        total += Number(f[f.length - 2]) || 0; // Obytes (the column before Coll)
      }
      return total;
    }
  } catch { /* unknown */ }
  return undefined;
}
/** CPU of the test's own ffmpeg and whip-push processes, in % of one core. */
function ownCpu() {
  const pids = cameras.flatMap((c) => c.pids ?? []);
  if (!pids.length) return 0;
  try {
    return execFileSync("ps", ["-o", "%cpu=", "-p", pids.join(",")]).toString().split("\n").reduce((a, x) => a + (parseFloat(x) || 0), 0);
  } catch {
    return 0;
  }
}
function senderSampler() {
  let last = { cpu: cpuTimes(), sent: bytesSent(), at: Date.now() };
  return () => {
    const now = { cpu: cpuTimes(), sent: bytesSent(), at: Date.now() };
    const machine = (now.cpu.busy - last.cpu.busy) / Math.max(1, now.cpu.all - last.cpu.all) * 100;
    const upMbps = now.sent !== undefined && last.sent !== undefined ? ((now.sent - last.sent) * 8) / ((now.at - last.at) / 1000) / 1e6 : undefined;
    last = now;
    return { machine, own: ownCpu(), upMbps };
  };
}
const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

const diskUsed = () => (o.ssh ? Number(ssh("df -B1 --output=used /var/lib/docker | tail -1").trim()) : undefined);
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const p95 = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] : null);

const info = o.ssh ? ssh("nproc; free -m | awk '/Mem:/ {print $2}'").trim().split("\n") : [];
const report = { api: API, started: new Date().toISOString(), server: o.ssh ? { cpus: Number(info[0]), memMb: Number(info[1]) } : null, sender: { cpus: CORES, platform: platform() }, steps: [] };
log("server:", report.server ?? "(no --ssh: recording and events only)");

try {
  for (const n of STEPS) {
    while (cameras.length < n) await addCamera(cameras.length);
    log(`${n} cameras (${cameras.filter((c) => c.busy).length} busy): warming up ${WARMUP_MS / 1000} s`);
    await sleep(WARMUP_MS);
    for (const c of cameras) c.restarts = 0;
    const from = new Date();
    const disk0 = diskUsed();
    const samples = [];
    const sender = [];
    const sampleSender = senderSampler();
    const seen = new Map(); // event id -> delay ms (first time we saw it minus occurred_at)
    const ids = new Set(cameras.map((c) => c.id));
    log(`measuring ${MEASURE_MS / 60_000} min`);
    for (let t = Date.now(); Date.now() - t < MEASURE_MS; ) {
      const s = serverSample();
      if (s) samples.push(s);
      sender.push(sampleSender());
      const ev = await call("GET", `/v1/events?from=${from.toISOString()}&limit=100`).catch(() => ({ data: [] }));
      for (const e of ev.data ?? []) {
        if (ids.has(e.source?.id) && !seen.has(e.id)) seen.set(e.id, Date.now() - Date.parse(e.occurred_at));
      }
      await sleep(o.ssh ? 3000 : 5000);
    }
    const to = new Date();
    const disk1 = diskUsed();
    // Recorded share of the window, per camera.
    const shares = [];
    const perCamera = [];
    for (const c of cameras) {
      const tl = await call("GET", `/v1/sources/${c.id}/timeline?from=${from.toISOString()}&to=${to.toISOString()}`).catch(() => ({ recorded: [] }));
      const ms = (tl.recorded ?? []).reduce((a, r) => a + Math.max(0, Math.min(Date.parse(r.to), +to) - Math.max(Date.parse(r.from), +from)), 0);
      shares.push(ms / (+to - +from));
      perCamera.push({ name: c.name, recorded: Math.round((ms / (+to - +from)) * 1000) / 10, reconnects: c.restarts });
    }
    const online = (await call("GET", "/v1/sources?limit=200")).data.filter((s) => ids.has(s.id) && s.status === "online").length;
    const cpu = {}; const mem = {};
    for (const svc of new Set(samples.flatMap((s) => Object.keys(s)))) {
      const xs = samples.map((s) => s[svc]).filter(Boolean);
      cpu[svc] = { avg: Math.round(xs.reduce((a, x) => a + x.cpu, 0) / xs.length), max: Math.round(Math.max(...xs.map((x) => x.cpu))) };
      mem[svc] = Math.max(...xs.map((x) => x.memMb));
    }
    const delays = [...seen.values()];
    const step = {
      cameras: n, busy: cameras.filter((c) => c.busy).length, online,
      recorded_min: Math.round(Math.min(...shares) * 1000) / 10, recorded_avg: Math.round((shares.reduce((a, x) => a + x, 0) / shares.length) * 1000) / 10,
      reconnects: cameras.reduce((a, c) => a + c.restarts, 0), events: delays.length,
      event_delay_s: { median: median(delays) && Math.round(median(delays) / 100) / 10, p95: p95(delays) && Math.round(p95(delays) / 100) / 10 },
      cpu_pct_of_one_core: cpu, mem_mb_max: mem,
      disk_gb_per_camera_day: disk0 !== undefined && disk1 !== undefined ? Math.round(((disk1 - disk0) / n / ((+to - +from) / 86_400_000)) / 1e8) / 10 : null,
      // This machine: all of it (% of all cores), the test's own processes (% of one core), and the upload rate.
      sender: {
        cpu_pct: { avg: Math.round(avg(sender.map((x) => x.machine)) ?? 0), max: Math.round(Math.max(0, ...sender.map((x) => x.machine))) },
        test_processes_pct_of_one_core: { avg: Math.round(avg(sender.map((x) => x.own)) ?? 0), max: Math.round(Math.max(0, ...sender.map((x) => x.own))) },
        upload_mbps: sender.some((x) => x.upMbps !== undefined)
          ? { avg: r1(avg(sender.filter((x) => x.upMbps !== undefined).map((x) => x.upMbps))), min: r1(Math.min(...sender.filter((x) => x.upMbps !== undefined).map((x) => x.upMbps))) }
          : null,
      },
      // The cameras that recorded least, with how often each dropped.
      worst_cameras: perCamera.sort((a, b) => a.recorded - b.recorded).slice(0, 3),
    };
    // A failing step is the sender's fault, not the server's, when this machine was flat out while the server wasn't.
    const serverBusiest = Math.max(0, ...Object.values(cpu).map((x) => x.max)) / ((report.server?.cpus ?? 1) * 100);
    step.limited_by = step.sender.cpu_pct.max >= 85 && (!report.server || serverBusiest < 0.7) ? "sender" : null;
    report.steps.push(step);
    log(JSON.stringify(step));
    writeFileSync(join(process.cwd(), "load-report.json"), JSON.stringify(report, null, 2));
    const brain = cpu.brain?.avg;
    if (step.recorded_min < 95 || step.reconnects > n || (step.event_delay_s.median ?? 0) > 10 || (brain && report.server && brain > report.server.cpus * 90)) {
      log(step.limited_by === "sender"
        ? `stopping: this computer was the limit (CPU up to ${step.sender.cpu_pct.max}%), not the server; run from a stronger machine or with fewer cameras per machine`
        : step.sender.cpu_pct.max >= 60 || (step.sender.upload_mbps && step.sender.upload_mbps.min < n * 0.4)
          ? `stopping: this step had gaps; this computer was busy too (CPU up to ${step.sender.cpu_pct.max}%, upload down to ${step.sender.upload_mbps?.min ?? "?"} Mbps), so check the sender before blaming the server`
          : "stopping: this step is past what the server handles well");
      break;
    }
  }
} finally {
  await cleanup();
  log("report written to load-report.json");
  for (const s of report.steps) {
    const c = s.cpu_pct_of_one_core;
    console.log(`${String(s.cameras).padStart(3)} cams (${s.busy} busy)  recorded ≥${s.recorded_min}%  reconnects ${s.reconnects}  events ${s.events}, delay ${s.event_delay_s.median ?? "-"} s (p95 ${s.event_delay_s.p95 ?? "-"})` +
      (c.brain ? `  cpu: brain ${c.brain.avg}% media ${c.media?.avg}% api ${c.api?.avg}% postgres ${c.postgres?.avg}%` : "") +
      (s.disk_gb_per_camera_day !== null ? `  disk ${s.disk_gb_per_camera_day} GB/camera/day` : "") +
      `  this computer: cpu ${s.sender.cpu_pct.avg}% (max ${s.sender.cpu_pct.max}%)` + (s.sender.upload_mbps ? `, up ${s.sender.upload_mbps.avg} Mbps (min ${s.sender.upload_mbps.min})` : "") +
      (s.limited_by === "sender" ? "  ← limited by this computer" : ""));
  }
}
