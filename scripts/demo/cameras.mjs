#!/usr/bin/env node
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Demo cameras: three fake cameras that play a short story from the fixtures/
// clips over WHIP, so you can try watches, questions and replay without a
// camera (and without your own home on screen).
//
//   Front door   empty porch; a courier leaves a parcel; later someone takes it
//   Yard         a truck drives in and stays parked
//   Living room  a dog on the bed, the whole time
//
// It also creates two watches on the front door. Cameras keep showing their
// last scene until Ctrl-C; their recordings stay for questions afterwards.
//
//   SENSEPLANE_API_KEY=sk_... node scripts/demo/cameras.mjs --api https://cams.example.com
//
// On your own computer (https://localhost), Caddy's certificate isn't trusted
// by default; pass its root, from the folder with docker-compose.yml:
//
//   docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt > caddy-root.crt
//   SENSEPLANE_API_KEY=sk_... node scripts/demo/cameras.mjs --api https://localhost --ca caddy-root.crt
//
// Needs Node 22+, Go 1.23+ and ffmpeg. The key is a workspace key (Agents →
// Workspace keys). Clips: CC BY 3.0 vpdonline and Museum of Municipal
// Engineering (Kraków), CC BY 2.0 Diego Torres Silvestre; see fixtures/README.md.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values: o } = parseArgs({
  options: {
    api: { type: "string" }, delivery: { type: "string", default: "2" }, pickup: { type: "string", default: "8" },
    ca: { type: "string" }, "no-watches": { type: "boolean", default: false },
  },
});
const KEY = process.env.SENSEPLANE_API_KEY ?? "";
if (!o.api || !KEY.startsWith("sk_")) {
  console.error("usage: SENSEPLANE_API_KEY=sk_... node scripts/demo/cameras.mjs --api https://<your domain> [--delivery 2] [--pickup 8] (minutes)");
  process.exit(2);
}
const API = o.api.replace(/\/$/, "");
const DELIVERY_S = Number(o.delivery) * 60;
const PICKUP_S = Number(o.pickup) * 60;
if (!(DELIVERY_S >= 0 && PICKUP_S >= DELIVERY_S + 60)) {
  console.error("--pickup must be at least a minute after --delivery");
  process.exit(2);
}
if (o.ca && process.env.NODE_EXTRA_CA_CERTS !== resolve(o.ca)) {
  // Node reads extra CAs only at start-up: run again with it set.
  process.on("SIGINT", () => undefined); // the child handles Ctrl-C
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit", env: { ...process.env, NODE_EXTRA_CA_CERTS: resolve(o.ca) } });
  process.exit(r.status ?? 0);
}

const log = (...a) => console.log(`[demo ${new Date().toTimeString().slice(0, 8)}]`, ...a);
async function call(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method, headers: { authorization: `Bearer ${KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${json?.error?.message ?? ""}`);
  return json;
}

const fixture = (f) => join(ROOT, "fixtures", f);
const work = mkdtempSync(join(tmpdir(), "senseplane-demo-"));
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args]);
const ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-r", "15", "-g", "30", "-bf", "0", "-an"];

/** A still frame from a clip (first, or last with `last`). */
function still(clip, last) {
  const out = join(work, `${clip}-${last ? "last" : "first"}.png`);
  ff([...(last ? ["-sseof", "-0.2"] : []), "-i", fixture(clip), "-frames:v", "1", "-update", "1", out]);
  return out;
}
/** A still held for `seconds`, as a clip. */
function hold(png, seconds, name) {
  const out = join(work, `${name}.mp4`);
  ff(["-loop", "1", "-framerate", "15", "-t", String(seconds), "-i", png, ...ENCODE, out]);
  return out;
}
/** Part of a clip, re-encoded to match the held stills. */
function cut(clip, from, name) {
  const out = join(work, `${name}.mp4`);
  ff(["-ss", String(from), "-i", fixture(clip), ...ENCODE, out]);
  return out;
}

log("preparing the story…");
const DELIVERED = "doorstep-delivery-reversed-640x360.mp4"; // a courier leaves a box (40 s; the courier is in view 7.6–28 s)
const TAKEN = "doorstep-parcel-640x360.mp4"; // someone takes the box (from 6 s: in view 1.8–21.5 s)
const VAN = "van-driving-640x360.mp4";
const front = [
  { file: hold(still(DELIVERED), DELIVERY_S, "porch-empty") },
  { file: cut(DELIVERED, 0, "courier") },
  { file: hold(still(DELIVERED, true), PICKUP_S - DELIVERY_S - 40, "parcel-waiting") },
  { file: cut(TAKEN, 6, "taken") },
  { file: hold(still(TAKEN, true), 10, "porch-after"), loop: true },
];
const yard = [{ file: cut(VAN, 0, "truck-arrives") }, { file: hold(still(VAN, true), 10, "truck-parked"), loop: true }];
const living = [{ file: fixture("dog-indoors-640x480.mp4"), loop: true }];

const whipPush = join(work, "whip-push");
execFileSync("go", ["build", "-o", whipPush, "./cmd/whip-push"], { cwd: join(ROOT, "bridge"), stdio: "inherit" });

let stopping = false;
const running = [];

/** Plays the scenes in order into one WHIP session; the last one loops. Reconnects where it was. */
function play(cam, scenes) {
  let i = 0;
  let current;
  let ended = false;
  const wp = spawn(whipPush, ["-endpoint", cam.url, "-fps", "15", ...(o.ca ? ["-ca", resolve(o.ca)] : [])], { env: { ...process.env, WHIP_TOKEN: cam.token }, stdio: ["pipe", "ignore", "pipe"] });
  wp.stdin.on("error", () => undefined);
  let stderr = "";
  wp.stderr.on("data", (d) => (stderr = (stderr + d).slice(-300)));
  const next = () => {
    if (stopping || ended) return;
    const s = scenes[i];
    current = spawn("ffmpeg", ["-hide_banner", "-v", "error", "-re", ...(s.loop ? ["-stream_loop", "-1"] : []), "-i", s.file,
      "-an", "-c", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "h264", "-"]);
    current.stdout.pipe(wp.stdin, { end: false });
    current.on("exit", () => {
      if (i < scenes.length - 1) i++;
      next();
    });
  };
  wp.on("exit", () => {
    ended = true;
    current?.kill();
    if (stopping) return;
    log(`${cam.name} disconnected, reconnecting:`, stderr.replace(/eyJ[\w.-]+/g, "<token>").trim().split("\n").at(-1));
    setTimeout(() => play(cam, scenes.slice(i)), 2000);
  });
  next();
  running.push({ stop: () => { current?.kill(); wp.kill(); } });
}

async function camera(name, location) {
  const s = await call("POST", "/v1/sources", { name, type: "whip", location });
  log(`added ${name}`);
  return { id: s.id, name, url: s.ingest.whip_url, token: s.ingest.token };
}

const door = await camera("Front door", "Front porch");
const yardCam = await camera("Yard", "Back yard");
const livingCam = await camera("Living room", "Living room");

if (!o["no-watches"]) {
  for (const instruction of ["Tell me when a parcel is left at the front door", "Tell me if someone takes a parcel from the front door"]) {
    await call("POST", "/v1/watches", { instruction, sources: [door.id] })
      .then(() => log(`watch: ${instruction}`), (e) => log(`could not create the watch "${instruction}":`, e.message));
  }
}

const t0 = Date.now();
play(door, front);
play(yardCam, yard);
play(livingCam, living);

const at = (s) => new Date(t0 + s * 1000).toTimeString().slice(0, 5);
log(`story (times are approximate):
  ${at(0)}  Yard: a truck drives in and parks.   Living room: the dog is on the bed.
  ${at(DELIVERY_S + 8)}  Front door: a courier leaves a parcel
  ${at(PICKUP_S + 2)}  Front door: someone takes the parcel
  After that the cameras keep showing their last scene. Ctrl-C to stop.`);
for (const [s, what] of [[DELIVERY_S + 8, "a courier is at the front door"], [PICKUP_S + 2, "someone is taking the parcel"], [PICKUP_S + 30, "the story is done; ask away"]]) {
  setTimeout(() => log(what), s * 1000);
}

process.on("SIGINT", () => {
  stopping = true;
  for (const r of running) r.stop();
  log("stopped. The cameras go offline; their recordings and events stay.");
  setTimeout(() => process.exit(0), 500);
});
