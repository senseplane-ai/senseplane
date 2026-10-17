// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// WHIP ingest check (ADR 0034) against a running stack: a `whip` source gets
// a WHIP URL and token; the bridge's whip-push (Go, pion) publishes the test
// fixture to it from this machine, as OBS or any WHIP encoder would. Passes
// when the push connects, segments cover nearly all of what was sent (the
// last, open segment included), the source goes offline after the DELETE, and
// a revoked token is refused.
//
//   E2E_API_URL=http://localhost:58080 node whip-check.ts   (needs Go and ffmpeg)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccount } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:58080";
const SECONDS = Number(process.env.WHIP_SECONDS ?? 15);
const FIXTURE = new URL("../fixtures/testsrc-h264-640x360-20s.mp4", import.meta.url).pathname;
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: unknown) => {
  if (!ok) failures.push(name);
  log(name, { ok, detail });
};

const bin = join(mkdtempSync(join(tmpdir(), "sp-whip-")), "whip-push");
execFileSync("go", ["build", "-o", bin, "./cmd/whip-push"], { cwd: new URL("../bridge/", import.meta.url).pathname, stdio: "inherit" });

const { api_key: key } = createAccount("WHIP e2e");
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const src = await call("POST", "/v1/sources", { name: "OBS", type: "whip" });
// The bearer is a JWT naming the camera's room and the API's authorize URL (spec/media/whip.md).
check("whip_source_created", !!src.ingest?.whip_url && String(src.ingest?.token ?? "").split(".").length === 3, { whip_url: src.ingest?.whip_url });

/** Pushes the fixture (Annex B, unchanged) for `seconds`; resolves with whip-push's exit code and when it ended. */
function push(token: string, seconds: number) {
  return new Promise<{ code: number; endedAt: number; output: string }>((resolve) => {
    const ff = spawn("ffmpeg", ["-hide_banner", "-v", "error", "-re", "-i", FIXTURE, "-t", String(seconds), "-an", "-c", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "h264", "-"]);
    const wp = spawn(bin, ["-endpoint", src.ingest.whip_url, "-fps", "15"], { env: { ...process.env, WHIP_TOKEN: token } });
    let output = "";
    wp.stderr.on("data", (d) => (output += d));
    ff.stdout.pipe(wp.stdin);
    wp.stdin.on("error", () => undefined);
    wp.on("exit", (code) => resolve({ code: code ?? 1, endedAt: Date.now(), output: output.replace(/eyJ[A-Za-z0-9_.-]+/g, "<bearer>").slice(-500) }));
  });
}

const startedAt = Date.now();
const pushing = push(src.ingest.token, SECONDS);
const online = await (async () => {
  while (Date.now() - startedAt < 20_000) {
    if ((await call("GET", `/v1/sources/${src.id}`)).status === "online") return Date.now() - startedAt;
    await sleep(500);
  }
  return undefined;
})();
check("online_while_pushing", online !== undefined, { after_ms: online });
const pushed = await pushing;
check("push_connected_and_finished", pushed.code === 0 && pushed.output.includes("publishing to"), { code: pushed.code, output: pushed.output });

// Segments land within a few seconds of the end; the last, open one included.
let recordedMs = 0;
let range: { from: string; to: string } | undefined;
for (let i = 0; i < 20 && recordedMs < (SECONDS - 3) * 1000; i++) {
  await sleep(1000);
  const tl = await call("GET", `/v1/sources/${src.id}/timeline?from=${new Date(startedAt - 60_000).toISOString()}&to=${new Date().toISOString()}`);
  recordedMs = (tl.recorded as { from: string; to: string }[]).reduce((a, r) => a + Date.parse(r.to) - Date.parse(r.from), 0);
  range = tl.recorded.at(-1);
}
check("recorded_what_was_sent", recordedMs >= (SECONDS - 3) * 1000, { sent_s: SECONDS, recorded_ms: recordedMs, last: range });
const tail = range ? pushed.endedAt - Date.parse(range.to) : Infinity;
check("last_segment_kept", tail < 4000, { recording_ends_ms_before_push_end: tail });

await sleep(2000);
check("offline_after_delete", (await call("GET", `/v1/sources/${src.id}`)).status === "offline", {});

await call("DELETE", `/v1/sources/${src.id}/ingest-token`);
// A real offer with the revoked bearer: the media plane asks the API, which refuses it.
const refused = await push(src.ingest.token, 3);
check("revoked_token_refused", refused.code !== 0 && /401|unauthorized/i.test(refused.output), { code: refused.code, output: refused.output });

log("done", { failures });
process.exit(failures.length ? 1 : 0);
