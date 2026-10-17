// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The m3 check: perception end to end, through the real pipeline:
//   fixture → dev replay publisher → media (segments + frames feed) → API (masks) →
//   Valkey → brain (YOLOX, tracker, YAMNet, episodes) → API (events, snapshots,
//   clips) → signed webhook → this script.
// Reports precision/recall per class against fixtures/labels.json, how long
// after a person enters the frame the signed webhook arrives, and whether the
// event's clip gets cut.
// Prereqs: compose infra + `--profile app` api (deploy/compose), a media
// service with MEDIA_DEV_REPLAY=1 reachable at E2E_MEDIA_URL, and the brain
// worker (VALKEY_URL) running. See docs/milestones/m3.md for the exact commands.
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { compose, devReplay } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const HOOK_HOST = process.env.E2E_HOOK_HOST ?? "host.docker.internal"; // how the API container reaches this script
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const LABELS = JSON.parse(readFileSync(`${FIXTURES}labels.json`, "utf8")).fixtures as Record<string, { expect: { label: string; from: number }[]; allow: string[] }>;
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

// E2E_CREATE_ACCOUNT runs the admin CLI another way (CI runs the API outside Docker).
const created = process.env.E2E_CREATE_ACCOUNT
  ? execFileSync("sh", ["-c", process.env.E2E_CREATE_ACCOUNT]).toString()
  : execFileSync("docker", [...compose, "exec", "-T", "api", "node", "dist/cli.js", "create-account", "Perception e2e"]).toString();
const { api_key: key, account_id: account } = JSON.parse(created.trim().split("\n").pop()!);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

// Webhook receiver: verifies every signature.
type Received = { at: number; event: Record<string, any>; signatureOk: boolean };
const received: Received[] = [];
let secret = "";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const m = String(req.headers["senseplane-signature"] ?? "").match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    const ok = !!m && createHmac("sha256", secret).update(`${m[1]}.${body}`).digest("hex") === m[2];
    received.push({ at: Date.now(), event: JSON.parse(body), signatureOk: ok });
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
const hookPort = (server.address() as { port: number }).port;
const hook = await call("POST", "/v1/webhooks", { url: `http://${HOOK_HOST}:${hookPort}/senseplane`, events: ["detection.person", "detection.vehicle", "detection.animal", "sound.detected"] });
secret = hook.secret;

const replay = devReplay(key);
const duration = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${FIXTURES}${f}`]).toString());

const runs: { fixture: string; source: string; startedAt: number }[] = [];
for (const fixture of Object.keys(LABELS)) {
  const src = await call("POST", "/v1/sources", { name: fixture.replace(/\.mp4$/, ""), type: "browser", record_audio: true });
  const startedAt = Date.now();
  await replay("/dev/replay", { account_id: account, source_id: src.id, file: `${FIXTURES}${fixture}` });
  log("replaying", { fixture, source: src.id });
  await new Promise((r) => setTimeout(r, duration(fixture) * 1000 + 2500));
  await replay("/dev/replay/stop", { source_id: src.id });
  runs.push({ fixture, source: src.id, startedAt });
  await new Promise((r) => setTimeout(r, 6000)); // let the last episode close before the next fixture
}
await new Promise((r) => setTimeout(r, 4000));

const labelOf = (e: Record<string, any>) => (e.type === "sound.detected" ? `sound:${e.labels[0]}` : e.labels[0]);
const stats: Record<string, { tp: number; fp: number; fn: number }> = {};
const perFixture: Record<string, string[]> = {};
let personLatencyMs: number | undefined;
let personEvent: Record<string, any> | undefined;
for (const r of runs) {
  const evs = received.filter((x) => x.event.source.id === r.source);
  perFixture[r.fixture] = evs.map((x) => `${labelOf(x.event)}@${((x.at - r.startedAt) / 1000).toFixed(1)}s`);
  const fired = new Set(evs.map((x) => labelOf(x.event)));
  const truth = LABELS[r.fixture]!;
  const expected = new Set(truth.expect.map((e) => e.label));
  for (const cls of new Set([...fired, ...expected])) {
    const s = (stats[cls] ??= { tp: 0, fp: 0, fn: 0 });
    if (expected.has(cls) && fired.has(cls)) s.tp++;
    else if (expected.has(cls)) s.fn++;
    else if (!truth.allow.includes(cls)) s.fp++;
  }
  const entered = truth.expect.find((e) => e.label === "person");
  const person = evs.find((x) => labelOf(x.event) === "person");
  if (entered && person) {
    personLatencyMs = person.at - (r.startedAt + entered.from * 1000);
    personEvent = person.event;
  }
}

// The person event's clip: a playback URL at delivery time, then a saved clip once the window has been recorded.
let clipSaved = false;
if (personEvent) {
  for (let i = 0; i < 20 && !clipSaved; i++) {
    const ev = await call("GET", `/v1/events/${personEvent.id}`);
    const clips = (await call("GET", "/v1/clips")).data as { id: string }[];
    clipSaved = clips.some((c) => ev.media.clip_url?.includes("/playback/")) && clips.length > 0;
    if (!clipSaved) await new Promise((r) => setTimeout(r, 3000));
  }
}
server.close();

const report = Object.fromEntries(
  Object.entries(stats).map(([c, s]) => [c, { precision: +(s.tp / Math.max(s.tp + s.fp, 1)).toFixed(2), recall: +(s.tp / Math.max(s.tp + s.fn, 1)).toFixed(2), ...s }]),
);
const result = {
  perClass: report,
  perFixture,
  personWebhookAfterEnteringMs: personLatencyMs,
  personEventHadClipUrlOnDelivery: Boolean(personEvent?.media?.clip_url),
  personEventHadSnapshot: Boolean(personEvent?.media?.snapshot_url),
  eventClipSaved: clipSaved,
  allSignaturesValid: received.every((r) => r.signatureOk),
  webhooksReceived: received.length,
  pass: personLatencyMs !== undefined && personLatencyMs <= 2000 && Boolean(personEvent?.media?.clip_url) && received.every((r) => r.signatureOk) &&
    ["person", "vehicle", "animal", "sound:crying"].every((c) => report[c]?.recall === 1),
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
