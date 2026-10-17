// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The media contract through the API (ADR 0049), against a running stack:
//  1. newest replaces old: a second capture join for the same camera ends the
//     first with roomClosed "replaced" and a 1008, on whichever media plane;
//  2. the camera's feed egress is started at token time, records while the
//     camera publishes, is stopped after the camera has been offline for
//     FEED_IDLE_STOP_SECONDS, and the next token starts a new one.
//   E2E_API_URL=… E2E_MEDIA_URL=… E2E_DB_URL=… node media-check.ts
import pg from "pg";
import { createAccount, devReplay } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const DB = process.env.E2E_DB_URL ?? "postgres://senseplane:senseplane@localhost:55432/senseplane";
const STOP_S = Number(process.env.FEED_IDLE_STOP_SECONDS ?? 45);
const FIXTURE = new URL("../fixtures/testsrc-h264-640x360-20s.mp4", import.meta.url).pathname;
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = {}) => {
  if (!ok) failures.push(name);
  log(name, { ok, detail });
};

const { api_key: key } = createAccount("Media e2e");
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};
const db = new pg.Client({ connectionString: DB });
await db.connect();
const feed = async (id: string) => (await db.query("select session_id, stopped_at, stop_reason from media_feeds where source_id = $1", [id])).rows[0] as
  { session_id: string; stopped_at: Date | null; stop_reason: string | null } | undefined;
/** A fresh capture link and its join: what a capture page does on every (re)connect. */
const join = async (id: string) => {
  const ticket = (await call("POST", `/v1/sources/${id}/capture-link`)).ingest.token;
  const r = await fetch(`${API}/v1/capture/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
  if (!r.ok) throw new Error(`capture join: ${r.status}`);
  return (await r.json()) as { token: string; url: string };
};

class Peer {
  events: Record<string, unknown>[] = [];
  closed?: { code: number; reason: string };
  private ws: WebSocket;
  private n = 0;
  private replies = new Map<number, (r: Record<string, unknown>) => void>();
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (m) => {
      const f = JSON.parse(String(m.data));
      if (f.event) this.events.push(f);
      else this.replies.get(f.id)?.(f);
    });
    this.ws.addEventListener("close", (e) => (this.closed = { code: e.code, reason: e.reason }));
  }
  async join(token: string) {
    if (this.ws.readyState !== WebSocket.OPEN) await new Promise((r) => this.ws.addEventListener("open", r, { once: true }));
    const id = this.n++;
    return new Promise<Record<string, unknown>>((resolve) => {
      this.replies.set(id, resolve);
      this.ws.send(JSON.stringify({ method: "join", id, protocolVersion: 1, token }));
    });
  }
  close() {
    this.ws.close();
  }
}

try {
  // 1. Newest replaces old.
  const cam = await call("POST", "/v1/sources", { name: "Replace rule", type: "browser" });
  const a = await join(cam.id);
  const first = new Peer(a.url);
  check("first_join_ok", (await first.join(a.token)).ok === true);
  const b = await join(cam.id);
  const second = new Peer(b.url);
  check("second_join_ok", (await second.join(b.token)).ok === true);
  for (let i = 0; i < 50 && !first.closed; i++) await sleep(100);
  check("older_connection_replaced", first.events.some((e) => e.event === "roomClosed" && e.reason === "replaced") && first.closed?.code === 1008, { events: first.events.map((e) => e.event), closed: first.closed });
  check("newer_connection_kept", !second.closed);
  second.close();

  // 2. The feed: started at token time, stopped after the camera is offline long enough, started again by the next token.
  const src = await call("POST", "/v1/sources", { name: "Feed lifecycle", type: "browser" });
  const replay = devReplay(key);
  const r = await replay("/dev/replay", { source_id: src.id, file: FIXTURE });
  check("replay_started", r.ok, { status: r.status });
  const started = await feed(src.id);
  check("feed_started_at_token_time", !!started && !started.stopped_at, started);
  let recorded = 0;
  for (let i = 0; i < 40 && recorded < 6000; i++) {
    await sleep(1000);
    const tl = await call("GET", `/v1/sources/${src.id}/timeline?from=${new Date(Date.now() - 600_000).toISOString()}&to=${new Date().toISOString()}`);
    recorded = (tl.recorded as { from: string; to: string }[]).reduce((s, x) => s + Date.parse(x.to) - Date.parse(x.from), 0);
  }
  check("feed_records_segments", recorded >= 6000, { recorded_ms: recorded });
  await replay("/dev/replay/stop", { source_id: src.id });
  for (let i = 0; i < 30 && (await call("GET", `/v1/sources/${src.id}`)).status !== "offline"; i++) await sleep(1000);
  const offlineAt = Date.now();
  let stopped = await feed(src.id);
  while (!stopped?.stopped_at && Date.now() - offlineAt < (STOP_S + 90) * 1000) {
    await sleep(3000);
    stopped = await feed(src.id);
  }
  check("feed_stopped_after_offline", !!stopped?.stopped_at && stopped.stop_reason === "offline" && Date.now() - offlineAt >= (STOP_S - 5) * 1000,
    { after_s: Math.round((Date.now() - offlineAt) / 1000), stop_reason: stopped?.stop_reason });
  await join(src.id);
  const again = await feed(src.id);
  check("next_token_restarts_feed", !!again && !again.stopped_at && again.session_id !== started?.session_id, { session: again?.session_id });
} finally {
  await db.end();
}
log("done", { failures });
process.exit(failures.length ? 1 : 0);
