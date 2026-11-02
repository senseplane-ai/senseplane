// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Ingest check (ADR 0045), against a running stack (API, media, brain):
//  1. sensors: an integration token pushes temperatures; a watch "temperature
//     above 27 for 5 min" fires reading.threshold once; read_environment (MCP)
//     returns the latest reading; home sensors (ADR 0060): a door's state per
//     device, a "left open" watch, a doorbell, "how many times was the fridge
//     opened", and read_environment with states;
//  2. bridge: go2rtc serves an RTSP camera (a looped H.264 fixture, copied),
//     the bridge container claims it with --rtsp and relays it over WHIP;
//     segments are recorded and the source is online; stopping the RTSP feed
//     turns the source reconnecting (credentials redacted), restarting it
//     brings it back online.
//
//   E2E_API_URL=http://localhost:35080 E2E_COMPOSE_PROJECT=sp-ingest \
//   E2E_BRIDGE_IMAGE=senseplane/bridge:dev node ingest-check.ts   (needs mcp/ built)
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { compose } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const PROJECT = process.env.E2E_COMPOSE_PROJECT ?? "senseplane";
const IMAGE = process.env.E2E_BRIDGE_IMAGE ?? "senseplane/bridge:dev";
const GO2RTC_IMAGE = process.env.E2E_GO2RTC_IMAGE ?? "alexxit/go2rtc:1.9.14";
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const MCP_DIST = new URL("../mcp/dist/", import.meta.url).pathname;
const NET = `${PROJECT}_default`;
const RTSP_NAME = `${PROJECT}-e2e-rtsp`;
const BRIDGE_NAME = `${PROJECT}-e2e-bridge`;
const PASSWORD = "e2e-secret-pw";
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const results: Record<string, unknown> = {};
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown) => {
  results[name] = { ok, detail };
  if (!ok) failures.push(name);
  log(name, { ok, detail });
};

const { api_key: owner } = JSON.parse(docker(...compose, "exec", "-T", "api", "node", "dist/cli.js", "create-account", "Ingest e2e").trim().split("\n").pop()!);
const call = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const until = async <T>(what: string, ms: number, fn: () => Promise<T | undefined>): Promise<{ value?: T; ms: number }> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return { value: v, ms: Date.now() - t0 };
    await sleep(1000);
  }
  log(`timed out: ${what}`);
  return { ms: Date.now() - t0 };
};

// --- 1. Sensors and a threshold watch --------------------------------------
{
  const sensor = await call(owner, "POST", "/v1/sources", { name: "Server room", location: "Server room", type: "sensor", senses: ["temperature"] });
  const token = sensor.ingest.integration_token as string;
  const who = await call(token, "GET", "/v1/integration");
  const watch = await call(owner, "POST", "/v1/watches", { instruction: "Warn me if the temperature is above 27 for 5 min", sources: [sensor.id] });
  check("sensor_watch_compiled", watch.compiled?.trigger?.type === "sensor" && watch.compiled.trigger.above === 27 && watch.compiled.trigger.min_duration_s === 300, watch.compiled?.trigger);
  const t0 = Date.now() - 15 * 60_000;
  const temps = [25, 26, 27.5, 28, 28.5, 29, 29, 29.5, 30, 26];
  const batch = temps.map((v, i) => ({ sense: "temperature", value: v, unit: "celsius", at: new Date(t0 + i * 60_000).toISOString() }));
  const first = await call(token, "POST", `/v1/sources/${sensor.id}/readings`, { readings: batch.slice(0, 6) });
  const second = await call(token, "POST", `/v1/sources/${sensor.id}/readings`, { readings: batch.slice(6) });
  const events = (await call(owner, "GET", `/v1/events?source=${sensor.id}&type=reading.threshold`)).data;
  check("reading_threshold_fired_once", who.source.id === sensor.id && first.events.length === 0 && second.events.length === 1 && events.length === 1 && events[0].watch_id === watch.id,
    { first: first.events.length, second: second.events.length, event: events[0] && { type: events[0].type, value: events[0].value, summary: events[0].summary } });
  const denied = await fetch(`${API}/v1/sources`, { headers: { authorization: `Bearer ${token}` } });
  check("integration_token_scoped", denied.status === 403, denied.status);

  const mcp = new Client({ name: "ingest-e2e", version: "1" });
  await mcp.connect(new StdioClientTransport({ command: "node", args: [`${MCP_DIST}stdio.js`], env: { ...process.env, SENSEPLANE_API_KEY: owner, SENSEPLANE_API_URL: `${API}/v1` } as Record<string, string> }));
  const env: any = await mcp.callTool({ name: "read_environment", arguments: { room: "Server room" } });
  await mcp.close();
  const envJson = JSON.parse(env.content.find((c: any) => c.type === "text").text);
  const r = envJson.sources?.[0]?.readings?.[0];
  check("read_environment_latest", r?.sense === "temperature" && r?.value === 26, envJson.sources?.[0]);
}

// --- 1b. Home sensors: states, events and devices (ADR 0060) --------------------
{
  const home = await call(owner, "POST", "/v1/sources", { name: "Flat", location: "Kitchen", type: "sensor", senses: ["temperature"] });
  const token = home.ingest.integration_token as string;
  // Compiled with the request, so the check doesn't depend on a recorded model answer.
  const watch = await call(owner, "POST", "/v1/watches", { instruction: "Tell me if the fridge door is left open for 5 minutes", sources: [home.id],
    compiled: { trigger: { type: "sensor", sense: "contact", state: true, device: "Fridge door", min_duration_s: 300 }, cooldown_s: 0, active_hours: null } });
  const fridge = { id: "binary_sensor.fridge", name: "Fridge door" };
  const t0 = Date.now() - 60 * 60_000;
  const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
  const pushed = await call(token, "POST", `/v1/sources/${home.id}/readings`, { readings: [
    { sense: "contact", value: true, device: fridge, at: at(0) }, { sense: "contact", value: false, device: fridge, at: at(1) },
    { sense: "contact", value: true, device: fridge, at: at(10) }, { sense: "contact", value: true, device: fridge, at: at(16) },
    { sense: "contact", value: false, device: fridge, at: at(17) },
    { sense: "doorbell", at: at(20) },
    { sense: "power", value: 1900, unit: "watt", device: { id: "sensor.kettle_power", name: "Kettle" }, at: at(30) },
  ] });
  check("home_readings_accepted", pushed.accepted === 7 && pushed.events.length === 1, pushed);
  const ev = (await call(owner, "GET", `/v1/events?source=${home.id}&type=reading.threshold`)).data[0];
  check("door_left_open_fired", ev?.watch_id === watch.id && ev?.value?.state === "open" && ev?.value?.device?.name === "Fridge door", ev && { summary: ev.summary, value: ev.value });
  const src = await call(owner, "GET", `/v1/sources/${home.id}`);
  check("sensor_gained_senses", ["contact", "doorbell", "power"].every((x) => src.senses.includes(x)), src.senses);
  const count = await call(owner, "POST", "/v1/activity/query", { measure: "count", what: { sensor: { sense: "contact", state: true, device: "Fridge door" } }, period: "last_24_hours", sources: [home.id] });
  check("fridge_opened_count", count.value === 2, count);

  const mcp = new Client({ name: "ingest-e2e-home", version: "1" });
  await mcp.connect(new StdioClientTransport({ command: "node", args: [`${MCP_DIST}stdio.js`], env: { ...process.env, SENSEPLANE_API_KEY: owner, SENSEPLANE_API_URL: `${API}/v1` } as Record<string, string> }));
  const env: any = await mcp.callTool({ name: "read_environment", arguments: { source: home.id } });
  await mcp.close();
  const readings = JSON.parse(env.content.find((c: any) => c.type === "text").text).sources?.[0]?.readings ?? [];
  const door = readings.find((x: any) => x.sense === "contact");
  check("read_environment_states", door?.state === "closed" && door?.device === "Fridge door" && door?.since === at(17)
    && readings.some((x: any) => x.sense === "doorbell" && x.last === "rang") && readings.some((x: any) => x.sense === "power" && x.value === 1900), readings);
}

// --- 2. Bridge: RTSP → WHIP → recording, then reconnecting ----------------------
const cleanup = () => {
  for (const n of [BRIDGE_NAME, RTSP_NAME]) {
    try {
      docker("rm", "-f", n);
    } catch {
      /* not running */
    }
  }
};
cleanup();
try {
  const startRtsp = () => docker("run", "-d", "--name", RTSP_NAME, "--network", NET, "--network-alias", "camera",
    "-v", `${FIXTURES}:/fixtures:ro`, "--entrypoint", "go2rtc", GO2RTC_IMAGE, "-config",
    // Copied, not encoded: the fixture's H.264 looped out as an RTSP camera.
    JSON.stringify({ api: { listen: "" }, webrtc: { listen: "" }, rtsp: { listen: ":8554" },
      streams: { cam: "exec:ffmpeg -hide_banner -v error -re -stream_loop -1 -i /fixtures/testsrc-h264-640x360-20s.mp4 -an -c copy -rtsp_transport tcp -f rtsp {output}" } }));
  startRtsp();
  await sleep(2000);

  const cam = await call(owner, "POST", "/v1/sources", { name: "Driveway", type: "rtsp" });
  check("rtsp_source_created", /^brg_/.test(cam.ingest.bridge_token) && cam.ingest.docker_command.includes("--rtsp"), { docker_command: cam.ingest.docker_command.replace(cam.ingest.bridge_token, "brg_<redacted>") });
  const media = docker(...compose, "ps", "-q", "media").trim();
  // The bridge shares the media container's network so it reaches WHIP and the RTC port as 127.0.0.1;
  // the API and the camera by their compose names.
  docker("run", "-d", "--name", BRIDGE_NAME, "--network", `container:${media}`, IMAGE,
    "--api", "http://api:8080", "--token", cam.ingest.bridge_token, "--rtsp", `rtsp://e2e:${PASSWORD}@camera:8554/cam`,
    "--whip-base", "http://127.0.0.1:8090", "--listen", "127.0.0.1:8098");

  const online = await until("bridge camera online", 60_000, async () => {
    const s = await call(owner, "GET", `/v1/sources/${cam.id}`);
    return s.status === "online" ? s : undefined;
  });
  check("bridge_camera_online", !!online.value, { after_ms: online.ms, status_since: online.value?.status_since });
  await sleep(20_000);
  const tl = await call(owner, "GET", `/v1/sources/${cam.id}/timeline?from=${new Date(Date.now() - 300_000).toISOString()}`);
  const recordedMs = tl.recorded.reduce((n: number, r: any) => n + (Date.parse(r.to) - Date.parse(r.from)), 0);
  check("segments_recorded", recordedMs >= 10_000, { recorded_ms: recordedMs, ranges: tl.recorded.length });

  const killedAt = Date.now();
  docker("rm", "-f", RTSP_NAME);
  const reconnecting = await until("reconnecting", 45_000, async () => {
    const s = await call(owner, "GET", `/v1/sources/${cam.id}`);
    return s.status === "reconnecting" ? s : undefined;
  });
  check("reconnecting_after_feed_killed", !!reconnecting.value && !String(reconnecting.value.status_detail).includes(PASSWORD),
    { after_ms: Date.now() - killedAt, status_detail: reconnecting.value?.status_detail, status_since: reconnecting.value?.status_since });
  await sleep(5000);
  const still = await call(owner, "GET", `/v1/sources/${cam.id}`);
  check("stays_reconnecting_after_media_offline", still.status === "reconnecting", still.status);

  startRtsp();
  const back = await until("back online", 90_000, async () => {
    const s = await call(owner, "GET", `/v1/sources/${cam.id}`);
    return s.status === "online" ? s : undefined;
  });
  check("back_online_after_feed_restored", !!back.value, { after_ms: back.ms });
  const logs = execFileSync("docker", ["logs", BRIDGE_NAME], { stdio: ["ignore", "pipe", "pipe"] });
  const all = logs.toString();
  check("bridge_logs_have_no_password", !all.includes(PASSWORD) && all.includes("rtsp://***@camera"), { lines: all.split("\n").length });
} finally {
  cleanup();
}

log("ingest e2e done", { failures });
console.log(JSON.stringify(results, null, 2));
process.exit(failures.length ? 1 : 0);
