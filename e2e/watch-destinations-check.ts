// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Watch destinations end to end (ADR 0043), through the real pipeline:
// two webhooks and one agent; a watch that notifies webhook A and the agent;
// the doorstep fixture replayed through media → brain → API. Checks that only
// webhook A (signed) and the agent's inbox get watch.triggered, that webhook B
// still gets the detections it subscribes to, that the agent is told over MCP
// (stdio notification, then what_happened returns it first and marks it seen),
// and that a backtest of the same watch over the replayed range finds it
// within its check budget.
//
// Prereqs: compose infra + `--profile app` api and brain with
// WEBHOOK_ALLOW_PRIVATE=1 (and a model in .env), a media service with
// MEDIA_DEV_REPLAY=1 at E2E_MEDIA_URL (see docs/milestones/m3.md), mcp/ built.
//   E2E_API_URL=http://localhost:58080 E2E_COMPOSE_PROJECT=senseplane node watch-destinations-check.ts
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { compose, devReplay } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const HOOK_HOST = process.env.E2E_HOOK_HOST ?? "host.docker.internal";
const FIXTURE = "doorstep-delivery-reversed-640x360.mp4";
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const MCP_DIST = new URL("../mcp/dist/", import.meta.url).pathname;
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const created = process.env.E2E_CREATE_ACCOUNT
  ? execFileSync("sh", ["-c", process.env.E2E_CREATE_ACCOUNT]).toString()
  : execFileSync("docker", [...compose, "exec", "-T", "api", "node", "dist/cli.js", "create-account", "Destinations e2e"]).toString();
const { api_key: owner, account_id: account } = JSON.parse(created.trim().split("\n").pop()!);
const call = async (key: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const replay = devReplay(owner);
const duration = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${FIXTURES}${f}`]).toString());

// Two receivers; each checks the signature with its own secret.
type Got = { type: string; watch_id?: string; source: { id: string; name?: string }; summary: string; signed: boolean };
async function receiver() {
  const got: Got[] = [];
  let secret = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const [t, v1] = String(req.headers["senseplane-signature"]).split(",").map((x) => x.split("=")[1]);
      const signed = v1 === createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
      const e = JSON.parse(body);
      got.push({ type: e.type, watch_id: e.watch_id, source: e.source, summary: e.summary, signed });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
  const url = `http://${HOOK_HOST}:${(server.address() as { port: number }).port}/hook`;
  return { got, server, url, setSecret: (s: string) => (secret = s) };
}
const a = await receiver();
const b = await receiver();
const hookA = await call(owner, "POST", "/v1/webhooks", { url: a.url, events: ["watch.triggered"] });
a.setSecret(hookA.secret);
const hookB = await call(owner, "POST", "/v1/webhooks", { url: b.url, events: ["watch.triggered", "detection.person"] });
b.setSecret(hookB.secret);

const cam = await call(owner, "POST", "/v1/sources", { name: "Front door", type: "browser" });
const agent = await call(owner, "POST", "/v1/agents", { name: "Door agent" });
await call(owner, "POST", "/v1/grants", { agent_id: agent.id, source_ids: [cam.id], senses: ["video"] });

// The watch names the camera by name, runs all day in London time, and notifies webhook A and the agent.
const instruction = "Tell me when a person shows up on this camera";
const watch = await call(owner, "POST", "/v1/watches", {
  instruction, sources: ["Front door"], notify: [{ type: "webhook", id: hookA.id }, { type: "agent", id: agent.id }],
  active_hours: { from: "00:00", to: "00:00", time_zone: "Europe/London" },
});
log("watch", { id: watch.id, compiled: watch.compiled, notify: watch.notify, active_hours: watch.active_hours, status: watch.status });

// The agent is connected over MCP (stdio) while it happens.
const notes: any[] = [];
const mcp = new Client({ name: "destinations-e2e", version: "1" });
mcp.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void notes.push(n.params));
await mcp.connect(new StdioClientTransport({
  command: "node", args: [`${MCP_DIST}stdio.js`],
  env: { ...process.env, SENSEPLANE_API_KEY: agent.api_key, SENSEPLANE_API_URL: `${API}/v1`, MCP_INBOX_POLL_SECONDS: "2" } as Record<string, string>,
}));

const from = new Date(Date.now() - 5000).toISOString();
await replay("/dev/replay", { account_id: account, source_id: cam.id, file: `${FIXTURES}${FIXTURE}` });
log("replaying", { fixture: FIXTURE });
await sleep(duration(FIXTURE) * 1000 + 3000);
await replay("/dev/replay/stop", { source_id: cam.id });
const to = new Date().toISOString();
// Deliveries, the inbox poll and the notification.
for (let i = 0; i < 60 && !(a.got.some((g) => g.type === "watch.triggered") && notes.length); i++) await sleep(1000);
await sleep(5000);

const text = (r: any) => JSON.parse(r.content.find((c: any) => c.type === "text").text);
const firstAsk = text(await mcp.callTool({ name: "what_happened", arguments: { question: "Did anyone come to the door?" } }));
const secondAsk = text(await mcp.callTool({ name: "what_happened", arguments: { question: "Did anyone come to the door?" } }));
const unseenAfter = (await call(agent.api_key, "GET", "/v1/inbox?unseen=true")).data.length;
await mcp.close();

const triggered = (await call(owner, "GET", `/v1/events?type=watch.triggered&source=${cam.id}`)).data;
const deliveriesB = (await call(owner, "GET", `/v1/webhooks/${hookB.id}/deliveries`)).data;
const bTriggered = deliveriesB.filter((d: any) => triggered.some((e: any) => e.id === d.event_id));

// Backtest the same watch over the replayed range, with a budget of 2 model checks.
const test = await call(owner, "POST", "/v1/watches/test", { watch_id: watch.id, from, to, max_checks: 2 });
const snap = test.matches[0]?.snapshot_url ? await fetch(test.matches[0].snapshot_url) : undefined;
// The same trigger with a model check and a budget of one: the check runs in the brain and is metered.
const before = (await call(owner, "GET", "/v1/usage")).ai_checks;
const checked = await call(owner, "POST", "/v1/watches/test", {
  compiled: { ...watch.compiled, verify: { prompt: "Is a person visible in this picture?", min_confidence: 0.5 } }, sources: [cam.id], from, to, max_checks: 1,
});
await sleep(3000); // brain usage is flushed about every second
const usage = await call(owner, "GET", "/v1/usage");
a.server.close();
b.server.close();

const aWatch = a.got.filter((g) => g.type === "watch.triggered");
const bWatch = b.got.filter((g) => g.type === "watch.triggered");
const result = {
  events_feed: triggered.map((e: any) => ({ id: e.id, summary: e.summary, source: e.source, verified: e.verified })),
  webhook_a: aWatch.map((g) => ({ watch_id: g.watch_id, source: g.source, signed: g.signed })),
  webhook_b: { watch_triggered: bWatch.length, watch_triggered_deliveries: bTriggered.length, detections: b.got.filter((g) => g.type === "detection.person").length, all_signed: b.got.every((g) => g.signed) },
  agent: {
    notifications: notes.map((n) => ({ logger: n.logger, events: n.data?.events?.map((e: any) => e.event_id) })),
    what_happened_new: firstAsk.new_from_your_watches?.map((e: any) => ({ event_id: e.event_id, source: e.source, summary: e.summary })) ?? [],
    second_call_new: secondAsk.new_from_your_watches?.length ?? 0,
    unseen_after: unseenAfter,
  },
  backtest: { candidates: test.candidates, checks_used: test.checks_used, unchecked: test.unchecked, matches: test.matches.map((m: any) => ({ source_name: m.source_name, at: m.at, verified: m.verified, summary: m.summary })), snapshot_status: snap?.status, snapshot_type: snap?.headers.get("content-type") },
  backtest_with_check: { checks_used: checked.checks_used, unchecked: checked.unchecked, matches: checked.matches.map((m: any) => ({ verified: m.verified, confidence: m.confidence, summary: m.summary })) },
  ai_checks: { before_checked_backtest: before, total: usage.ai_checks, by_kind: usage.ai_checks_by_kind },
};
const ids = new Set(triggered.map((e: any) => e.id));
const pass =
  triggered.length >= 1 &&
  aWatch.length === triggered.length && aWatch.every((g) => g.signed && g.watch_id === watch.id && g.source.name === "Front door") &&
  bWatch.length === 0 && bTriggered.length === 0 && result.webhook_b.detections >= 1 && result.webhook_b.all_signed &&
  notes.some((n) => n.logger === "senseplane.inbox" && n.data.events.some((e: any) => ids.has(e.event_id))) &&
  result.agent.what_happened_new.length === triggered.length && result.agent.what_happened_new.every((e: any) => ids.has(e.event_id)) &&
  result.agent.second_call_new === 0 && unseenAfter === 0 &&
  test.candidates >= 1 && test.checks_used <= 2 && (!watch.compiled.verify || test.checks_used >= 1) && test.matches.length >= 1 &&
  snap?.status === 200 &&
  checked.checks_used === 1 && checked.unchecked === checked.candidates - 1 && usage.ai_checks === before + 1;
console.log(JSON.stringify({ ...result, pass }, null, 2));
process.exit(pass ? 0 : 1);
