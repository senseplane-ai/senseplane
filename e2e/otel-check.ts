// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// OpenTelemetry end-to-end check (ADR 0033): one replayed fixture must produce
// a single connected trace from the media plane to the webhook delivery:
//   media.frame (media) → brain.frame → brain.event.publish (brain)
//     → consume brain.event → webhook.deliver (api)
// asserted through Jaeger's query API. Also checks that segment uploads are
// traced into the API's indexer, and that no span carries a secret.
// Prereqs and exact commands: docs/observability.md ("Checking it end to end").
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { createAccount, devReplay } from "./lib.ts";

const API = process.env.E2E_API_URL ?? "http://localhost:38080";
const JAEGER = process.env.E2E_JAEGER_URL ?? "http://localhost:36686";
const HOOK_HOST = process.env.E2E_HOOK_HOST ?? "127.0.0.1";
const FIXTURE = new URL("../fixtures/doorstep-parcel-640x360.mp4", import.meta.url).pathname;
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const { api_key: key, account_id: account } = createAccount("Tracing e2e");
const call = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = res.status === 204 ? {} : await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

// Webhook receiver: notes the delivery id and whether a traceparent leaked to us (it must not).
const received: { delivery: string; event: Record<string, any>; leakedTraceparent: boolean; signatureOk: boolean }[] = [];
let secret = "";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const m = String(req.headers["senseplane-signature"] ?? "").match(/^t=(\d+),v1=([0-9a-f]{64})$/);
    const ok = !!m && createHmac("sha256", secret).update(`${m[1]}.${body}`).digest("hex") === m[2];
    received.push({ delivery: String(req.headers["senseplane-delivery"]), event: JSON.parse(body), leakedTraceparent: "traceparent" in req.headers, signatureOk: ok });
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
const hookPort = (server.address() as { port: number }).port;
const hook = await call("POST", "/v1/webhooks", { url: `http://${HOOK_HOST}:${hookPort}/senseplane`, events: ["detection.person"] });
secret = hook.secret;

const src = await call("POST", "/v1/sources", { name: "otel-doorstep", type: "browser", record_audio: false });
const replay = devReplay(key);
const startedAt = Date.now();
await replay("/dev/replay", { account_id: account, source_id: src.id, file: FIXTURE });
log("replaying", { source: src.id });
for (let i = 0; i < 60 && !received.length; i++) await new Promise((r) => setTimeout(r, 1000));
await new Promise((r) => setTimeout(r, 8000)); // a few segments uploaded, spans flushed (batch processors export every ~5 s)
await replay("/dev/replay/stop", { source_id: src.id });
server.close();
const person = received[0];
log("webhook", { received: received.length, delivery: person?.delivery, afterMs: person ? Date.now() - startedAt : undefined });

// Jaeger v2's query API (/api/v3) returns OTLP JSON; flatten it into one span list per trace.
type JSpan = { traceID: string; spanID: string; parentID?: string; operationName: string; service: string; tags: { key: string; value: unknown }[] };
type JTrace = { traceID: string; spans: JSpan[] };
type Attr = { key: string; value: Record<string, unknown> };
async function traces(service: string, operation: string): Promise<JTrace[]> {
  const q = new URLSearchParams({
    "query.service_name": service, "query.operation_name": operation, "query.search_depth": "50",
    "query.start_time_min": new Date(startedAt - 60_000).toISOString(), "query.start_time_max": new Date(Date.now() + 60_000).toISOString(),
  });
  const res = await fetch(`${JAEGER}/api/v3/traces?${q}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { result?: { resourceSpans: { resource: { attributes: Attr[] }; scopeSpans: { spans: Record<string, any>[] }[] }[] } };
  const byTrace = new Map<string, JSpan[]>();
  for (const rs of body.result?.resourceSpans ?? []) {
    const svc = String(Object.values(rs.resource.attributes.find((a) => a.key === "service.name")?.value ?? {})[0] ?? "");
    for (const ss of rs.scopeSpans) {
      for (const s of ss.spans) {
        const span: JSpan = {
          traceID: s.traceId, spanID: s.spanId, parentID: s.parentSpanId || undefined, operationName: s.name, service: svc,
          tags: ((s.attributes ?? []) as Attr[]).map((a) => ({ key: a.key, value: Object.values(a.value)[0] })),
        };
        byTrace.set(span.traceID, [...(byTrace.get(span.traceID) ?? []), span]);
      }
    }
  }
  return [...byTrace].map(([traceID, spans]) => ({ traceID, spans }));
}

// Find the delivery's trace (Jaeger may need a moment to index the last spans).
let trace: JTrace | undefined;
for (let i = 0; i < 15 && !trace; i++) {
  trace = (await traces("senseplane-api", "webhook.deliver")).find((t) =>
    t.spans.some((s) => s.operationName === "webhook.deliver" && s.tags.some((tg) => tg.key === "senseplane.delivery_id" && tg.value === person?.delivery)));
  if (!trace) await new Promise((r) => setTimeout(r, 2000));
}
const chain = ["media.frame", "brain.frame", "brain.event.publish", "consume brain.event", "webhook.deliver"];
const byName = new Map(trace?.spans.map((s) => [s.operationName, s]) ?? []);
const parentOf = (s: JSpan) => s.parentID;
const ids = new Set(trace?.spans.map((s) => s.spanID));
const services = [...new Set(trace?.spans.map((s) => s.service) ?? [])].sort();
// Each step's ancestor chain reaches the previous step (other spans may sit between them).
const ancestors = (s: JSpan) => {
  const out: string[] = [];
  for (let p = parentOf(s); p; p = parentOf(trace!.spans.find((x) => x.spanID === p)!)) {
    const ps = trace!.spans.find((x) => x.spanID === p);
    if (!ps) break;
    out.push(ps.operationName);
  }
  return out;
};
const linked = chain.slice(1).every((name, i) => {
  const s = byName.get(name);
  return s ? ancestors(s).includes(chain[i]!) : false;
});
const orphans = trace?.spans.filter((s) => parentOf(s) && !ids.has(parentOf(s)!)).map((s) => s.operationName) ?? [];

// Segment uploads: media.segment.upload → consume media.segment.written in the API.
const segTraces = await traces("senseplane-media", "media.segment.upload");
const segmentIndexed = segTraces.some((t) => t.spans.some((s) => s.operationName === "consume media.segment.written"));

// Privacy: no API key, webhook secret or frame bytes in any attribute we exported.
const all = [...(trace ? [trace] : []), ...segTraces];
const blob = JSON.stringify(all.map((t) => t.spans.map((s) => s.tags)));
const secretsLeaked = blob.includes(key) || (secret && blob.includes(secret));

const result = {
  traceId: trace?.traceID,
  spansInTrace: trace?.spans.length ?? 0,
  services,
  chainPresent: chain.filter((n) => byName.has(n)),
  chainLinked: linked,
  orphanSpans: orphans,
  segmentUploadTraces: segTraces.length,
  segmentIndexedInSameTrace: segmentIndexed,
  webhookGotNoTraceparent: received.every((r) => !r.leakedTraceparent),
  allSignaturesValid: received.every((r) => r.signatureOk),
  secretsInSpans: Boolean(secretsLeaked),
  pass: Boolean(trace) && linked && chain.every((n) => byName.has(n)) && services.join() === "senseplane-api,senseplane-brain,senseplane-media" &&
    segmentIndexed && received.every((r) => !r.leakedTraceparent) && !secretsLeaked,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);
