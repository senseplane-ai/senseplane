// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Ask end to end (ADR 0041), with a real model through the real pipeline: the
// doorstep fixture replayed on "Front door" and the van on "Driveway" (a van,
// and someone walking past), then
// "When did someone come to the door?" streamed from POST
// /v1/conversations/{id}/messages. Passes when the answer cites a moment that
// is a real person event on Front door, its snapshot loads, every cited moment
// is a real stored event (nothing invented), no vehicle is cited, and the
// answer was metered as AI checks. One question, so
// a handful of model calls. Prereqs as m3-check.ts (API, media with
// MEDIA_DEV_REPLAY=1, brain with AI_BASE_URL / AI_API_KEY).
//
//   E2E_API_URL=http://localhost:31080 E2E_MEDIA_URL=http://localhost:31090 E2E_CREATE_ACCOUNT="…" node chat-check.ts
import { execFileSync } from "node:child_process";
import { compose, devReplay } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const FIXTURES = new URL("../fixtures/", import.meta.url).pathname;
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const created = process.env.E2E_CREATE_ACCOUNT
  ? execFileSync("sh", ["-c", process.env.E2E_CREATE_ACCOUNT]).toString()
  : execFileSync("docker", [...compose, "exec", "-T", "api", "node", "dist/cli.js", "create-account", "Ask e2e"]).toString();
const { api_key: key, account_id: account } = JSON.parse(created.trim().split("\n").pop()!);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const replay = devReplay(key);
const duration = (f: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${FIXTURES}${f}`]).toString());

const door = await call("POST", "/v1/sources", { name: "Front door", type: "browser", location: "Porch" });
const drive = await call("POST", "/v1/sources", { name: "Driveway", type: "browser" });
const clips = [[door, "doorstep-parcel-640x360.mp4"], [drive, "van-driving-640x360.mp4"]] as const;
for (const [src, f] of clips) {
  const r = await replay("/dev/replay", { account_id: account, source_id: src.id, file: `${FIXTURES}${f}` });
  if (!r.ok) throw new Error(`replay ${f}: ${r.status}`);
}
log("replaying", { door: door.id, driveway: drive.id });
await sleep(Math.max(...clips.map(([, f]) => duration(f))) * 1000 + 3000);
for (const [src] of clips) await replay("/dev/replay/stop", { source_id: src.id });

// Wait until the person event is stored and searchable.
let events: any[] = [];
for (let i = 0; i < 30 && !events.some((e) => e.source.id === door.id && e.type === "detection.person"); i++) {
  await sleep(2000);
  events = (await call("GET", "/v1/events?limit=50")).data;
}
log("events", { events: events.map((e) => ({ source: e.source.id === door.id ? "door" : "driveway", type: e.type, summary: e.summary })) });

const conv = await call("POST", "/v1/conversations", {});
const t0 = Date.now();
const res = await fetch(`${API}/v1/conversations/${conv.id}/messages`, {
  method: "POST", headers: { authorization: `Bearer ${key}`, accept: "text/event-stream", "content-type": "application/json" },
  body: JSON.stringify({ content: "When did someone come to the door?" }),
});
if (!res.ok) throw new Error(`ask: ${res.status} ${await res.text()}`);
const stream: { event: string; data: any; ms: number }[] = [];
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
  buffer += decoder.decode(chunk, { stream: true });
  let cut: number;
  while ((cut = buffer.indexOf("\n\n")) >= 0) {
    const block = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 2);
    const name = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (name && data) stream.push({ event: name, data: JSON.parse(data), ms: Date.now() - t0 });
  }
}
const done = stream.find((e) => e.event === "done")?.data.message;
const moments: any[] = done?.moments ?? [];
const personIds = new Set(events.filter((e) => e.source.id === door.id && e.type === "detection.person").map((e) => e.id));
const stored = new Map(events.map((e) => [e.id, e]));
const snapshot = moments[0]?.snapshot_url ? await fetch(moments[0].snapshot_url) : undefined;
await sleep(3000); // usage records reach the API through Valkey
const usage = await call("GET", "/v1/usage");

const result = {
  statuses: stream.filter((e) => e.event === "status").map((e) => e.data.text),
  first_delta_ms: stream.find((e) => e.event === "delta")?.ms,
  total_ms: stream.at(-1)?.ms,
  answer: done?.content,
  moments: moments.map((m) => ({ source: m.source_name, at: m.at, label: m.label, event_id: m.event_id, has_snapshot: Boolean(m.snapshot_url), has_clip: Boolean(m.clip_url) })),
  suggested_watch: done?.suggested_watch ?? null,
  snapshot: snapshot ? { status: snapshot.status, type: snapshot.headers.get("content-type") } : null,
  ai_checks: { total: usage.ai_checks, chat: usage.ai_checks_by_kind?.chat },
  error: stream.find((e) => e.event === "error")?.data ?? null,
};
const pass = Boolean(done) && /\[1\]/.test(done.content) && moments.length > 0
  && moments.every((m) => stored.has(m.event_id) && stored.get(m.event_id).type !== "detection.vehicle") && moments.some((m) => personIds.has(m.event_id))
  && snapshot?.status === 200 && result.statuses.length > 0 && Number(usage.ai_checks_by_kind?.chat) > 0;
console.log(JSON.stringify({ ...result, pass }, null, 2));
process.exit(pass ? 0 : 1);
