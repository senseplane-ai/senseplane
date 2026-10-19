// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Record and replay for model calls in the e2e suite. The brain talks to this
// as its OpenAI-compatible endpoint (AI_BASE_URL). In record mode every
// request goes to the real endpoint and the answer is kept in
// e2e/fixtures/model-replay.json; in replay mode (the default) answers come
// from that file and nothing leaves the machine, so a run costs nothing and
// needs no key.
//
// Requests are matched on what they ask, not on bytes: the text of every
// message with times, numbers and ids masked, plus the tools offered. Images
// are left out (frames differ run to run). When no recorded request matches
// exactly, the most similar one of the same kind (vision, text, chat with
// tools) answers.
//
// The same question can be asked of two different pictures (one watch, two
// cameras), so a recording is also kept per check and per occurrence within
// it ("m4|<key>|1" is the second time m4 asked it); replay prefers that, then
// the question alone. A check can also name a phase (POST /_phase), giving
// "m4:theft|<key>|0".
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

export interface Recording {
  key: string;
  kind: "vision" | "text" | "chat";
  text: string;
  status: number;
  contentType: string;
  body: string;
}

type Part = { type?: string; text?: string };
type Msg = { role?: string; content?: string | Part[] | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] };
type Req = { messages?: Msg[]; tools?: { function?: { name?: string } }[]; stream?: boolean };

const MASKS: [RegExp, string][] = [
  [/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, "<img>"],
  [/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>"],
  [/\b(?:src|evt|wat|agt|cnv|msg|whk|clp|inb|grt|key|usr|brg)_[0-9A-Za-z]+/g, "<id>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>"],
  [/\d+(?:\.\d+)?/g, "#"],
  [/\s+/g, " "],
];
const mask = (s: string) => MASKS.reduce((t, [re, to]) => t.replace(re, to), s).trim().toLowerCase();

/** What a request asks, comparable across runs. */
export function describe(req: Req): { key: string; kind: Recording["kind"]; text: string } {
  let images = false;
  const texts: string[] = [];
  for (const m of req.messages ?? []) {
    const c = m.content;
    if (typeof c === "string") texts.push(`${m.role}: ${c}`);
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (p.type === "image_url") images = true;
        else if (p.text) texts.push(`${m.role}: ${p.text}`);
      }
    }
    for (const t of m.tool_calls ?? []) texts.push(`${m.role} calls ${t.function?.name}(${t.function?.arguments ?? ""})`);
  }
  const tools = (req.tools ?? []).map((t) => t.function?.name).filter(Boolean).sort().join(",");
  const kind = tools ? "chat" : images ? "vision" : "text";
  const text = mask(texts.join("\n"));
  return { key: createHash("sha256").update(`${kind}|${tools}|${text}`).digest("hex").slice(0, 32), kind, text };
}

/**
 * What is kept of an answer: the content the brain reads. Provider routing,
 * request ids and costs are dropped, so the fixture says nothing about where
 * a recording was made or what it cost.
 */
export function sanitize(body: string, contentType: string): string {
  const clean = (o: Record<string, unknown>) => {
    for (const k of ["id", "provider", "system_fingerprint"]) delete o[k];
    const u = o.usage as Record<string, unknown> | undefined;
    if (u) for (const k of Object.keys(u)) if (!["prompt_tokens", "completion_tokens", "total_tokens"].includes(k)) delete u[k];
    return o;
  };
  if (contentType.includes("event-stream")) {
    return body.split("\n").map((line) => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") return line.startsWith(":") ? "" : line;
      try {
        return `data: ${JSON.stringify(clean(JSON.parse(line.slice(6))))}`;
      } catch {
        return line;
      }
    }).join("\n");
  }
  try {
    return JSON.stringify(clean(JSON.parse(body)));
  } catch {
    return body;
  }
}

const words = (s: string) => new Set(s.split(/[^a-z#<>]+/).filter((w) => w.length > 1));
function similarity(a: Set<string>, b: Set<string>) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.max(1, a.size + b.size - shared);
}

export interface ProxyOptions {
  port: number;
  file: string;
  /** Record against this OpenAI-compatible base URL (…/v1); unset replays. */
  upstream?: { baseUrl: string; apiKey: string };
  log?: (msg: string, extra?: object) => void;
}

export async function startModelProxy(o: ProxyOptions) {
  const recorded: Recording[] = existsSync(o.file) ? JSON.parse(readFileSync(o.file, "utf8")) : [];
  const byKey = new Map(recorded.map((r) => [r.key, r]));
  const stats = { exact: 0, similar: 0, missed: 0, recorded: 0 };
  let scope = "";
  const seen = new Map<string, number>();
  const occurrence = (key: string) => {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return `${scope}|${key}|${n}`;
  };
  const log = o.log ?? (() => {});

  const save = () => writeFileSync(o.file, JSON.stringify([...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)), null, 1) + "\n");

  async function answer(req: IncomingMessage, res: ServerResponse) {
    const raw = await new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => resolve(b));
    });
    // A check with two cameras asking the same question names each phase, so
    // one camera's recorded answers are never replayed to the other.
    if (req.method === "POST" && req.url === "/_phase") {
      const { name } = JSON.parse(raw || "{}") as { name?: string };
      scope = `${scope.split(":")[0]}${name ? `:${name}` : ""}`;
      seen.clear();
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "only POST /chat/completions" } }));
      return;
    }
    const body = JSON.parse(raw || "{}") as Req;
    const d = describe(body);
    const scoped = scope ? occurrence(d.key) : undefined;
    if (o.upstream) {
      const up = await fetch(`${o.upstream.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${o.upstream.apiKey}` }, body: raw,
      });
      const text = await up.text();
      const contentType = up.headers.get("content-type") ?? "application/json";
      if (up.ok) {
        const rec = { ...d, status: up.status, contentType, body: sanitize(text, contentType) };
        // A named phase's answers are kept for that phase only, so they never answer another check.
        if (!scope.includes(":")) byKey.set(d.key, rec);
        if (scoped) byKey.set(scoped, { ...rec, key: scoped });
        stats.recorded++;
        save();
      }
      res.writeHead(up.status, { "content-type": contentType }).end(text);
      return;
    }
    // Inside a named phase, only that phase's own recordings answer.
    const phased = scope.includes(":");
    let hit = (scoped ? byKey.get(scoped) : undefined) ?? (phased ? undefined : byKey.get(d.key));
    if (hit) stats.exact++;
    else {
      const mine = words(d.text);
      // The same turn of a tool loop first: a recording with as many tool calls so far answers this step, not an
      // earlier one (which would ask for the same tool again).
      const turn = (t: string) => (t.match(/assistant calls /g) ?? []).length;
      const myTurn = turn(d.text);
      let best = -1;
      for (const r of recorded) {
        if (r.kind !== d.kind || (phased ? !r.key.startsWith(`${scope}|`) : /^[^|]*:[^|]*\|/.test(r.key))) continue;
        const s = similarity(mine, words(r.text)) + (turn(r.text) === myTurn ? 1 : 0);
        if (s > best) [best, hit] = [s, r];
      }
      if (hit) stats.similar++;
    }
    if (!hit) {
      stats.missed++;
      log("model replay: nothing recorded for this request; run with E2E_LIVE_MODEL=1 to record", { kind: d.kind });
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "no recorded answer (E2E_LIVE_MODEL=1 records one)" } }));
      return;
    }
    res.writeHead(hit.status, { "content-type": hit.contentType }).end(hit.body);
  }

  const server = createServer((req, res) => void answer(req, res).catch((err) => {
    log("model proxy error", { err: String(err) });
    if (!res.headersSent) res.writeHead(502).end();
  }));
  // Docker Desktop reaches the host's loopback as host.docker.internal; on Linux the
  // containers come from the bridge, so listen there too (replay needs no key).
  const host = process.platform === "darwin" ? "127.0.0.1" : "0.0.0.0";
  if (host === "0.0.0.0" && o.upstream) log("model proxy: recording while listening on every interface; run it on a trusted network");
  await new Promise<void>((resolve) => server.listen(o.port, host, resolve));
  return {
    stats,
    mode: o.upstream ? "record" : "replay",
    /** The check now running: occurrences are counted per check. */
    scope(name: string) {
      scope = name;
      seen.clear();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
