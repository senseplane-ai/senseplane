// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Home check (ADR 0060, 0061), against a running stack and a real Home
// Assistant (its demo devices):
//  1. Home Assistant is onboarded over its API; one light is put in a room;
//  2. the bridge starts with no token and pairs with the code it shows; the
//     workspace approves it, and the box lists Home Assistant's entities;
//  3. a person chooses two; switching the light in Home Assistant reaches
//     Senseplane on the room's sensor source; an entity nobody chose doesn't;
//  4. the box keeps its pairing across a restart;
//  5. with Home Assistant gone, the room's sensors read as offline.
//
//   E2E_API_URL=http://localhost:38080 E2E_COMPOSE_PROJECT=sp-e2e \
//   E2E_BRIDGE_IMAGE=senseplane/bridge:dev node home-check.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const PROJECT = process.env.E2E_COMPOSE_PROJECT ?? "senseplane";
const IMAGE = process.env.E2E_BRIDGE_IMAGE ?? "senseplane/bridge:dev";
const HA_IMAGE = process.env.E2E_HA_IMAGE ?? "ghcr.io/home-assistant/home-assistant:2026.10.4";
const HA_PORT = Number(process.env.E2E_HA_PORT ?? 38812);
const NET = `${PROJECT}_default`;
const HA_NAME = `${PROJECT}-e2e-homeassistant`;
const BOX_NAME = `${PROJECT}-e2e-box`;
const BOX_DATA = `${PROJECT}-e2e-box-data`;
const HA = `http://127.0.0.1:${HA_PORT}`;
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
const until = async <T>(what: string, ms: number, fn: () => Promise<T | undefined>): Promise<T | undefined> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    await sleep(1000);
  }
  log(`timed out: ${what}`);
  return undefined;
};

const { api_key: owner } = JSON.parse(docker(...compose, "exec", "-T", "api", "node", "dist/cli.js", "create-account", "Home e2e").trim().split("\n").pop()!);
const call = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

/** One websocket command to Home Assistant (Node's own WebSocket client). */
async function haCommand(token: string, cmd: Record<string, unknown>): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${HA_PORT}/api/websocket`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("no answer")); }, 15_000);
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
      else if (m.type === "auth_ok") ws.send(JSON.stringify({ id: 1, ...cmd }));
      else if (m.type === "result") {
        clearTimeout(timer);
        ws.close();
        m.success ? resolve(m.result) : reject(new Error(JSON.stringify(m.error)));
      }
    };
    ws.onerror = () => reject(new Error("websocket failed"));
  });
}

const cleanup = () => {
  for (const n of [BOX_NAME, HA_NAME]) {
    try { docker("rm", "-f", n); } catch { /* not running */ }
  }
  try { docker("volume", "rm", "-f", BOX_DATA); } catch { /* none */ }
};
cleanup();
try {
  // --- 1. A real Home Assistant with its demo devices ---------------------------
  const config = mkdtempSync(join(tmpdir(), "sp-ha-"));
  writeFileSync(join(config, "configuration.yaml"), [
    "homeassistant:", "  name: E2E home", "  time_zone: UTC", "  unit_system: metric", "  country: DE", "",
    "default_config:", "demo:", "",
  ].join("\n"));
  docker("run", "-d", "--name", HA_NAME, "--network", NET, "--network-alias", "homeassistant", "-p", `127.0.0.1:${HA_PORT}:8123`, "-v", `${config}:/config`, HA_IMAGE);
  const up = await until("Home Assistant onboarding", 240_000, async () => {
    const r = await fetch(`${HA}/api/onboarding`);
    return r.ok ? r : undefined;
  });
  check("home_assistant_started", !!up, { image: HA_IMAGE });
  const client = "http://e2e.test/";
  const made = await (await fetch(`${HA}/api/onboarding/users`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: client, name: "E2E", username: "e2e", password: "e2e-password-123", language: "en" }) })).json() as { auth_code: string };
  const tok = await (await fetch(`${HA}/auth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: made.auth_code, client_id: client }) })).json() as { access_token: string };
  const haToken = tok.access_token;
  // The demo's entities appear a few seconds after start.
  const states = await until("demo entities", 120_000, async () => {
    const s = await (await fetch(`${HA}/api/states`, { headers: { authorization: `Bearer ${haToken}` } })).json() as { entity_id: string; attributes: Record<string, unknown> }[];
    return s.some((x) => x.entity_id.startsWith("light.")) && s.some((x) => x.entity_id.startsWith("binary_sensor.")) ? s : undefined;
  }) ?? [];
  const light = states.find((x) => x.entity_id.startsWith("light."))!.entity_id;
  const other = states.filter((x) => x.entity_id.startsWith("light."))[1]?.entity_id ?? states.find((x) => x.entity_id.startsWith("switch."))?.entity_id;
  const temp = states.find((x) => x.entity_id.startsWith("sensor.") && x.attributes.device_class === "temperature")?.entity_id;
  // Put the light in a room.
  const area = await haCommand(haToken, { type: "config/area_registry/create", name: "Sun room" });
  // On its device, as Home Assistant keeps rooms for most entities; the bridge reads the device's room.
  const entry = await haCommand(haToken, { type: "config/entity_registry/get", entity_id: light });
  await haCommand(haToken, entry.device_id
    ? { type: "config/device_registry/update", device_id: entry.device_id, area_id: area.area_id }
    : { type: "config/entity_registry/update", entity_id: light, area_id: area.area_id });
  log("home assistant ready", { light, other, temp, area: area.area_id, entities: states.length });

  // --- 2. Pair the box with a code -------------------------------------------------
  const startBox = () => docker("run", "-d", "--name", BOX_NAME, "--network", NET, "-v", `${BOX_DATA}:/data`, IMAGE,
    "--api", "http://api:8080", "--state-dir", "/data", "--box-name", "E2E Green", "--ha-url", "http://homeassistant:8123", "--ha-token", haToken,
    "--listen", "127.0.0.1:8099");
  startBox();
  const code = await until("the box's pairing code", 30_000, async () => {
    const m = docker("logs", BOX_NAME).match(/"code":"([A-Z0-9]{4}-[A-Z0-9]{4})"/);
    return m?.[1];
  });
  check("box_shows_a_code", !!code, { code });
  const waiting = await call(owner, "GET", `/v1/bridges/pair?code=${code}`);
  check("console_finds_the_box", waiting.name === "E2E Green", waiting);
  const box = await call(owner, "POST", "/v1/bridges/pair", { code, name: "E2E home" });
  const entities = await until("entities listed", 60_000, async () => {
    const e = (await call(owner, "GET", `/v1/bridges/${box.id}/entities`)).data as { entity_id: string; area: string | null; sense: string }[];
    return e.length ? e : undefined;
  }) ?? [];
  const lit = entities.find((e) => e.entity_id === light);
  check("box_lists_entities_with_rooms", !!lit && lit.area === "Sun room" && lit.sense === "switch" && entities.some((e) => e.sense === "temperature"),
    { count: entities.length, light: lit, senses: [...new Set(entities.map((e) => e.sense))] });

  // --- 3. Choose two; switch the light in Home Assistant -------------------------
  const chosen = await call(owner, "PATCH", `/v1/bridges/${box.id}/entities`, { choose: [light, ...(temp ? [temp] : [])] });
  const room = chosen.data.find((e: { entity_id: string }) => e.entity_id === light).source_id;
  await sleep(1500);
  const svc = (name: string, entity: string) => fetch(`${HA}/api/services/light/${name}`, { method: "POST", headers: { authorization: `Bearer ${haToken}`, "content-type": "application/json" }, body: JSON.stringify({ entity_id: entity }) });
  // The bridge picks up the choice on its next config poll (60 s), then sends the light's state at once.
  const first = await until("the chosen light's state", 90_000, async () => {
    const now = await call(owner, "GET", `/v1/sources/${room}/now`);
    return (now.readings ?? []).find((r: { device?: { id: string } }) => r.device?.id === light);
  });
  await svc("turn_off", light);
  const off = await until("the light turned off", 40_000, async () => {
    const now = await call(owner, "GET", `/v1/sources/${room}/now`);
    const r = (now.readings ?? []).find((x: { device?: { id: string } }) => x.device?.id === light);
    return r?.value === false ? r : undefined;
  });
  await svc("turn_on", light);
  const on = await until("the light turned on", 40_000, async () => {
    const now = await call(owner, "GET", `/v1/sources/${room}/now`);
    const r = (now.readings ?? []).find((x: { device?: { id: string } }) => x.device?.id === light);
    return r?.value === true ? r : undefined;
  });
  check("light_switching_reaches_senseplane", !!first && !!off && !!on && on.state === "on", { first, off, on });
  const src = await call(owner, "GET", `/v1/sources/${room}`);
  check("room_sensor_source", src.name === "Sun room sensors" && src.location === "Sun room" && src.bridge_id === box.id, { name: src.name, location: src.location });
  if (other) {
    await fetch(`${HA}/api/services/light/toggle`, { method: "POST", headers: { authorization: `Bearer ${haToken}`, "content-type": "application/json" }, body: JSON.stringify({ entity_id: other }) });
    await sleep(15_000);
    const sources = (await call(owner, "GET", "/v1/sources")).data as { id: string }[];
    const seen = [];
    for (const s of sources) seen.push(...((await call(owner, "GET", `/v1/sources/${s.id}/now`)).readings ?? []).map((r: { device?: { id: string } }) => r.device?.id));
    check("unchosen_entities_stay_home", !seen.includes(other), { other, seen });
  }
  const health = (await call(owner, "GET", "/v1/bridges")).data.find((b: { id: string }) => b.id === box.id);
  check("box_reports_home_assistant", health?.online === true && health?.home_assistant?.connected === true && health.home_assistant.entities === entities.length, health);

  // --- 4. The pairing survives a restart -------------------------------------------
  docker("restart", BOX_NAME);
  await sleep(8000);
  const logs = docker("logs", "--since", "10s", BOX_NAME);
  const bridges = (await call(owner, "GET", "/v1/bridges")).data;
  check("pairing_kept_across_restart", !/waiting to be paired/.test(logs) && /bridge started/.test(logs) && bridges.length === 1, { bridges: bridges.length });

  // --- 5. Home Assistant goes away: the room's sensors read as offline -------------
  docker("stop", HA_NAME);
  const gone = await until("the room's sensors offline", 60_000, async () => {
    const s = await call(owner, "GET", `/v1/sources/${room}`);
    return s.status === "offline" ? s : undefined;
  });
  const after = (await call(owner, "GET", "/v1/bridges")).data.find((b: { id: string }) => b.id === box.id);
  check("sensors_offline_without_home_assistant", !!gone && after?.home_assistant?.connected === false, { status: gone?.status, home_assistant: after?.home_assistant });
} catch (err) {
  check("home_check_ran", false, String(err));
} finally {
  try { log("box logs", { tail: docker("logs", "--tail", "20", BOX_NAME).split("\n").map((l) => l.replace(/brg_[A-Za-z0-9_-]+/g, "brg_<redacted>")) }); } catch { /* none */ }
  cleanup();
}

console.log(JSON.stringify({ ...results, pass: failures.length === 0 }, null, 2));
process.exit(failures.length ? 1 : 0);
