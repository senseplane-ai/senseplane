// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The m4 check: watches end to end with a real model, through the real pipeline: a package watch
// compiled by the LLM, both doorstep clips replayed (a delivery, and someone
// taking the parcel away), the VLM verifying each fire, `ask` on a live
// source, and memory search for the courier. Reports model calls and cost from
// the usage records. Prereqs as m3-check.ts, with the brain started with
// AI_BASE_URL / AI_API_KEY / AI_MODEL_VISION / AI_MODEL_TEXT.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { compose, devReplay } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const HOOK_HOST = process.env.E2E_HOOK_HOST ?? "host.docker.internal";
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const labels = JSON.parse(readFileSync(`${FIXTURES}labels.json`, "utf8"));
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const created = process.env.E2E_CREATE_ACCOUNT
  ? execFileSync("sh", ["-c", process.env.E2E_CREATE_ACCOUNT]).toString()
  : execFileSync("docker", [...compose, "exec", "-T", "api", "node", "dist/cli.js", "create-account", "Watches e2e"]).toString();
const { api_key: key, account_id: account } = JSON.parse(created.trim().split("\n").pop()!);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const replay = devReplay(key);
const duration = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${FIXTURES}${f}`]).toString());

const received: { at: number; event: Record<string, any> }[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ at: Date.now(), event: JSON.parse(body) });
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
await call("POST", "/v1/webhooks", { url: `http://${HOOK_HOST}:${(server.address() as { port: number }).port}/h`, events: ["watch.triggered"] });

const delivery = await call("POST", "/v1/sources", { name: "Front door (delivery)", type: "browser", location: "Front door" });
const theft = await call("POST", "/v1/sources", { name: "Front door (parcel taken)", type: "browser", location: "Front door" });
const t0 = Date.now();
const watch = await call("POST", "/v1/watches", { instruction: labels.watches.package.instruction, sources: [delivery.id, theft.id] });
log("watch compiled", { ms: Date.now() - t0, compiled: watch.compiled, estimate: watch.estimate, warnings: watch.warnings });

// Both cameras ask the model the same question; replay must keep their answers apart.
const phase = (name: string) =>
  process.env.E2E_MODEL_PROXY_URL ? fetch(`${process.env.E2E_MODEL_PROXY_URL}/_phase`, { method: "POST", body: JSON.stringify({ name }) }).then(() => {}) : Promise.resolve();
let ask: unknown;
for (const [src, fixture] of [[theft, "doorstep-parcel-640x360.mp4"], [delivery, "doorstep-delivery-reversed-640x360.mp4"]] as const) {
  await phase(src === theft ? "theft" : "delivery");
  await replay("/dev/replay", { account_id: account, source_id: src.id, file: `${FIXTURES}${fixture}` });
  log("replaying", { fixture });
  if (src === delivery) {
    await sleep(18_000); // the person is at the door with the box
    ask = await call("POST", `/v1/sources/${src.id}/ask`, { question: "Is someone at the door, and what are they carrying?" });
    log("ask", ask as object);
    await sleep(duration(fixture) * 1000 - 18_000 + 3000);
  } else {
    await sleep(duration(fixture) * 1000 + 3000);
  }
  await replay("/dev/replay/stop", { source_id: src.id });
  await sleep(8000);
}
await sleep(10_000);

const watchEvents = received.filter((r) => r.event.type === "watch.triggered");
const onDelivery = watchEvents.filter((r) => r.event.source.id === delivery.id);
const onTheft = watchEvents.filter((r) => r.event.source.id === theft.id);
const search = await call("GET", `/v1/memory/search?q=${encodeURIComponent("when did the courier come?")}`);
const top = search.data[0];
const usage = execFileSync("docker", [...compose, "exec", "-T", "postgres", "psql", "-U", "senseplane", "-tAc",
  `select kind, sum(quantity) from usage_records where account_id='${account}' group by kind order by kind`]).toString().trim();
server.close();

const result = {
  compiler: watch.compiled,
  deliveryFires: onDelivery.map((r) => r.event.summary),
  parcelTakenFires: onTheft.map((r) => r.event.summary),
  ask,
  whatHappened: top ? { summary: top.event.summary, type: top.event.type, score: top.score, isTheDeliveryEvent: top.event.source.id === delivery.id && top.event.type === "watch.triggered" } : null,
  usage: Object.fromEntries(usage.split("\n").filter(Boolean).map((l) => l.split("|")).map(([k, v]) => [k, Number(v)])),
  pass: onDelivery.length === 1 && onTheft.length === 0 && top?.event?.type === "watch.triggered" && top?.event?.source?.id === delivery.id,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
