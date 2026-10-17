// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The m6 check, against a running stack (API, media replay, brain with a model):
//  1. a video-only grant: MCP `listen` errors, `look` works;
//  2. a privacy mask: masked pixels are black in the snapshot and the model
//     (asked about that region) sees black;
//  3. revocation: seconds from deleting a connected app's grant (and then
//     disconnecting it) to its next MCP call failing, over remote MCP with
//     OAuth (consent approved the way the console does it, ADR 0048);
//  4. metering: a known load (a replayed fixture of known length, N asks)
//     against GET /v1/usage.
//
//   E2E_API_URL=http://localhost:48080 node m6-check.ts   (needs mcp/ built)
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";
import { compose, devReplay } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:48080";
const MCP_PORT = Number(process.env.E2E_MCP_PORT ?? 48061);
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const MCP_DIST = new URL("../mcp/dist/", import.meta.url).pathname;
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, unknown> = {};
const db = new pg.Client({ connectionString: process.env.E2E_DB_URL ?? "postgres://senseplane:senseplane@localhost:55432/senseplane" });
await db.connect();

const { api_key: owner, account_id: account } = JSON.parse(
  execFileSync("docker", [...compose, "exec", "-T", "api", "node", "dist/cli.js", "create-account", "Trust e2e"]).toString().trim().split("\n").pop()!,
);
const call = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 || res.status === 202 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const replay = devReplay(owner);
const duration = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${FIXTURES}${f}`]).toString());
const text = (r: any) => r.content.find((c: any) => c.type === "text")?.text ?? "";

const cam = await call(owner, "POST", "/v1/sources", { name: "Front door", type: "browser", record_audio: true });
const agent = await call(owner, "POST", "/v1/agents", { name: "Door agent" });
await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [cam.id], senses: ["video"] });

// --- 1 + 4: replay the crying fixture (audio + video); the agent can look, not listen.
const t0 = Date.now();
await replay("/dev/replay", { account_id: account, source_id: cam.id, file: `${FIXTURES}baby-crying-audio-640x360.mp4` });
await sleep(8000);
const stdio = new Client({ name: "m6-stdio", version: "1" });
await stdio.connect(new StdioClientTransport({ command: "node", args: [`${MCP_DIST}stdio.js`], env: { ...process.env, SENSEPLANE_API_KEY: agent.api_key, SENSEPLANE_API_URL: `${API}/v1` } as Record<string, string> }));
const senses = JSON.parse(text(await stdio.callTool({ name: "list_senses", arguments: {} })));
const listen: any = await stdio.callTool({ name: "listen", arguments: { source: cam.id, seconds: 2 } });
const look: any = await stdio.callTool({ name: "look", arguments: { source: cam.id } });
results.video_only = {
  list_senses: senses.sources.map((s: any) => s.senses), listen_error: listen.isError ? JSON.parse(text(listen)).error.code : null,
  look_image: look.content[0]?.type === "image",
};
const ownerListen = JSON.parse(text(await (async () => {
  const c = new Client({ name: "m6-owner", version: "1" });
  await c.connect(new StdioClientTransport({ command: "node", args: [`${MCP_DIST}stdio.js`], env: { ...process.env, SENSEPLANE_API_KEY: owner, SENSEPLANE_API_URL: `${API}/v1` } as Record<string, string> }));
  const r = await c.callTool({ name: "listen", arguments: { source: cam.id, seconds: 2 } });
  await c.close();
  return r;
})()));
(results.video_only as any).owner_listen_sounds = ownerListen.sounds?.map((s: any) => s.sounds.join(","));
await stdio.close();
log("video-only grant", results.video_only as object);

// Let the fixture finish, then stop: the known load is its recorded length.
await sleep(Math.max(0, duration("baby-crying-audio-640x360.mp4") * 1000 + 2500 - (Date.now() - t0)));
await replay("/dev/replay/stop", { source_id: cam.id });
const publishedMs = Date.now() - t0;

// --- 2: privacy mask over the left half; replay the doorstep clip.
await call(owner, "PATCH", `/v1/sources/${cam.id}`, { privacy_masks: [[[0, 0], [0.5, 0], [0.5, 1], [0, 1]]] });
await sleep(1500);
await replay("/dev/replay", { account_id: account, source_id: cam.id, file: `${FIXTURES}doorstep-delivery-reversed-640x360.mp4` });
await sleep(14000);
const now = await call(owner, "GET", `/v1/sources/${cam.id}/now`);
const jpeg = Buffer.from(await (await fetch(now.snapshot_url)).arrayBuffer());
const gray = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", "scale=64:36,format=gray", "-f", "rawvideo", "pipe:1"], { input: jpeg });
let leftMax = 0, rightMean = 0;
for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) {
  const v = gray[y * 64 + x]!;
  if (x < 30) leftMax = Math.max(leftMax, v); else if (x >= 34) rightMean += v / (30 * 36);
}
const vlm = await call(owner, "POST", `/v1/sources/${cam.id}/ask`, { question: "Is the left half of this image completely black (no detail at all)? Answer yes or no, and describe the right half briefly." });
results.mask = { snapshot_left_max_gray: leftMax, snapshot_right_mean_gray: Math.round(rightMean), model_answer: vlm.answer, model_confidence: vlm.confidence };
await replay("/dev/replay/stop", { source_id: cam.id });
await call(owner, "PATCH", `/v1/sources/${cam.id}`, { privacy_masks: [] });
log("mask", results.mask as object);

// --- 3: revocation over remote MCP. The consent step is done the way the console does it
// (ADR 0048): read the sealed request, approve it at the API for a connect code, post that
// code to /oauth/approve. Account keys may approve (they act as an owner).
const mcp = spawn("node", [`${MCP_DIST}server.js`], { env: { ...process.env, PORT: String(MCP_PORT), SENSEPLANE_API_URL: `${API}/v1`, MCP_PUBLIC_URL: `http://localhost:${MCP_PORT}`, MCP_CONSOLE_URL: "http://console.invalid", MCP_TOKEN_SECRET: randomBytes(16).toString("hex"), LOG_LEVEL: "warn" }, stdio: "inherit" });
await sleep(1500);
async function connectApp(): Promise<{ token: string; agentId: string }> {
  const b = `http://localhost:${MCP_PORT}`;
  const redirect = "http://127.0.0.1:53682/cb";
  const reg = await (await fetch(`${b}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "m6", redirect_uris: [redirect] }) })).json();
  const verifier = randomBytes(32).toString("base64url");
  const q = { client_id: reg.client_id, redirect_uri: redirect, response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" };
  const auth = await fetch(`${b}/oauth/authorize?${new URLSearchParams(q)}`, { redirect: "manual" });
  const request = new URLSearchParams(new URL(auth.headers.get("location")!).hash.slice(1)).get("request")!;
  const info = await (await fetch(`${b}/oauth/request?${new URLSearchParams({ request })}`)).json();
  const approved = await call(owner, "POST", "/v1/agents/connect", {
    client_name: info.client_name, redirect_host: info.redirect_host, binding: info.binding, source_ids: [cam.id], senses: ["video"],
  });
  const c = await fetch(`${b}/oauth/approve`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request, code: approved.code }) });
  const code = new URL(c.headers.get("location")!).searchParams.get("code")!;
  const token = (await (await fetch(`${b}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect }) })).json()).access_token as string;
  return { token, agentId: approved.agent.id };
}
const app = await connectApp();
const appGrant = (await call(owner, "GET", "/v1/grants")).data.find((g: any) => g.agent_id === app.agentId);
const remote = new Client({ name: "m6-remote", version: "1" });
await remote.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${MCP_PORT}/mcp`), { requestInit: { headers: { authorization: `Bearer ${app.token}` } } }));
const sees = async () => JSON.parse(text(await remote.callTool({ name: "list_senses", arguments: {} }))).sources?.length ?? 0;
const before = await sees();
const r0 = Date.now();
await call(owner, "DELETE", `/v1/grants/${appGrant.id}`);
while ((await sees()) > 0 && Date.now() - r0 < 120_000) await sleep(200);
const grantRevokedS = (Date.now() - r0) / 1000;
await call(owner, "POST", "/v1/grants", { agent_id: app.agentId, source_ids: [cam.id], senses: ["video"] });
const r1 = Date.now();
await call(owner, "DELETE", `/v1/agents/${app.agentId}`); // Disconnect on the Agents page
let agentBlocked = false;
while (!agentBlocked && Date.now() - r1 < 120_000) {
  const r: any = await remote.callTool({ name: "list_senses", arguments: {} }).catch(() => ({ isError: true }));
  agentBlocked = !!r.isError;
  if (!agentBlocked) await sleep(200);
}
results.revocation = { sources_before: before, grant_revoked_after_s: grantRevokedS, agent_revoked_after_s: (Date.now() - r1) / 1000, agent_blocked: agentBlocked };
await remote.close();
mcp.kill();
log("revocation", results.revocation as object);

// --- 4: usage against the known load.
const asks = 3;
await replay("/dev/replay", { account_id: account, source_id: cam.id, file: `${FIXTURES}doorstep-delivery-reversed-640x360.mp4` });
await sleep(9000);
for (let i = 0; i < asks; i++) await call(owner, "POST", `/v1/sources/${cam.id}/ask`, { question: "Is anyone at the door?" });
await sleep(25_000);
await replay("/dev/replay/stop", { source_id: cam.id });
await sleep(8000); // last segment indexed, usage flushed
const indexMs = Number((await db.query("select coalesce(sum(duration_ms),0) n from segments where account_id = $1", [account])).rows[0].n);
const u = await call(owner, "GET", "/v1/usage");
const expectedChecks = 1 /* mask question */ + asks;
results.usage = {
  camera_minutes: u.camera_minutes, by_resolution: u.camera_minutes_by_resolution, index_minutes: Math.round(indexMs / 600) / 100,
  camera_vs_index_pct: Math.round(Math.abs(u.camera_minutes - indexMs / 60_000) / (indexMs / 60_000) * 10000) / 100,
  first_replay_published_s: Math.round(publishedMs / 100) / 10,
  ai_checks: u.ai_checks, ai_checks_by_kind: u.ai_checks_by_kind, ai_checks_expected_ask: expectedChecks,
  sources: u.sources,
};
log("usage", results.usage as object);
await db.end();

const pass = (results.video_only as any).listen_error === "forbidden_sense" && (results.video_only as any).look_image
  && (results.mask as any).snapshot_left_max_gray <= 16 && (results.mask as any).snapshot_right_mean_gray > 30
  && (results.revocation as any).grant_revoked_after_s <= 60 && (results.revocation as any).agent_blocked && (results.revocation as any).agent_revoked_after_s <= 60
  && (results.usage as any).camera_vs_index_pct <= 1 && u.ai_checks_by_kind.ask === expectedChecks;
log(pass ? "PASS" : "FAIL", results);
process.exitCode = pass ? 0 : 1;
