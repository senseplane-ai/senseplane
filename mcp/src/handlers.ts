// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The 8 tools, each a thin call into the public API through the TypeScript
// SDK. Results are short JSON text for the model plus, for `look`, the image
// itself so the agent can see it.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema, type CallToolResult, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
  SubscribeRequestSchema, UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Senseplane, SenseplaneError } from "senseplane";
import { INBOX_URI, inboxBrief, subscriptions } from "./inbox.js";
import { tools } from "./tools.js";
import { SpanKind, SpanStatusCode, withSpan } from "@senseplane/telemetry";

type Args = Record<string, unknown>;
type Source = { id: string; name: string; location?: string; type: string; senses: string[]; status: string };

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (code: string, message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] });

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/**
 * Media URLs carry the API's public address; inside a container network that
 * address may not resolve, so SENSEPLANE_PUBLIC_API_URL (that public origin) is
 * mapped back to SENSEPLANE_API_URL's origin when fetching images.
 */
function internalUrl(url: string): string {
  const pub = process.env.SENSEPLANE_PUBLIC_API_URL?.replace(/\/$/, "");
  const api = process.env.SENSEPLANE_API_URL;
  if (!pub || !api || !url.startsWith(pub)) return url;
  return new URL(api).origin + url.slice(pub.length);
}

export function createHandlers(client: Senseplane, fetchImpl: typeof fetch = fetch) {
  let cache: { at: number; sources: Source[] } | undefined;
  const sources = async () => {
    if (!cache || Date.now() - cache.at > 10_000) cache = { at: Date.now(), sources: (await all(client.sources.list())) as Source[] };
    return cache.sources;
  };
  /** Accepts an id or a (case-insensitive) name, so agents can say "front door". */
  const resolve = async (ref: unknown): Promise<Source> => {
    const r = String(ref ?? "").trim();
    const list = await sources();
    const hit = list.find((s) => s.id === r) ?? list.find((s) => s.name.toLowerCase() === r.toLowerCase());
    if (!hit) throw new SenseplaneError(404, "not_found", `no source "${r}"; call list_senses for the ids`);
    return hit;
  };
  const image = async (url: string) => {
    const res = await fetchImpl(internalUrl(url));
    if (!res.ok) return undefined;
    return { type: "image" as const, data: Buffer.from(await res.arrayBuffer()).toString("base64"), mimeType: res.headers.get("content-type")?.split(";")[0] || "image/jpeg" };
  };
  const brief = (e: { id: string; type: string; source: unknown; occurred_at: string; summary: string; confidence: number | null; media?: object }) =>
    ({ id: e.id, type: e.type, source: e.source, occurred_at: e.occurred_at, summary: e.summary, confidence: e.confidence, ...(e.media ?? {}) });
  /** This caller's agent id (agent keys have an inbox; account keys don't). */
  let me: Promise<string | null> | undefined;
  const agentId = () => (me ??= client.inbox.list({ limit: 1 }).then((r) => r.agent_id, (err) => {
    if (!(err instanceof SenseplaneError && err.status < 500)) me = undefined; // a transient failure: ask again next time
    return null;
  }));

  const handlers: Record<string, (a: Args) => Promise<CallToolResult>> = {
    async list_senses() {
      const list = await sources();
      return text({ sources: list.map((s) => ({ id: s.id, name: s.name, location: s.location, type: s.type, senses: s.senses, status: s.status })) });
    },

    async look(a) {
      const src = await resolve(a.source);
      if (!src.senses.includes("video")) return fail("forbidden_sense", `${src.name} has no video`);
      if (a.question) {
        const r = await client.sources.ask(src.id, { question: String(a.question) });
        const img = await image(r.snapshot_url);
        return { content: [...(img ? [img] : []), { type: "text", text: JSON.stringify({ source: src.id, answer: r.answer, confidence: r.confidence, snapshot_url: r.snapshot_url }, null, 2) }] };
      }
      const now = await client.sources.now(src.id);
      if (!now.snapshot_url) return fail("not_found", `${src.name} has no picture yet`);
      const img = await image(now.snapshot_url);
      if (!img) return fail("not_found", `${src.name} isn't streaming right now (no live frame)`);
      return { content: [img, { type: "text", text: JSON.stringify({ source: src.id, captured_at: now.captured_at, snapshot_url: now.snapshot_url }, null, 2) }] };
    },

    async listen(a) {
      const src = await resolve(a.source);
      if (!src.senses.includes("audio")) return fail("forbidden_sense", `${src.name} has no audio (or it isn't granted)`);
      const seconds = Math.min(60, Math.max(1, Number(a.seconds ?? 10)));
      const start = Date.now() - 5000;
      await new Promise((r) => setTimeout(r, seconds * 1000));
      // A sound is one episode (one event when it starts), so include episodes still going on.
      const events = await all(client.events.list({ source: src.id, from: new Date(start - 600_000).toISOString() }));
      const sounds = events
        .filter((e) => e.type.startsWith("sound.") && (Date.parse(e.occurred_at) >= start || !e.ended_at || Date.parse(e.ended_at) >= start))
        .map((e) => ({ sounds: e.labels, confidence: e.confidence, started_at: e.occurred_at, ongoing: !e.ended_at, summary: e.summary }));
      return text({ source: src.id, listened_seconds: seconds, sounds, note: sounds.length ? undefined : "No sounds detected (speech is never transcribed)." });
    },

    async read_environment(a) {
      const list = await sources();
      const room = a.room ? String(a.room).toLowerCase() : undefined;
      const picked = a.source ? [await resolve(a.source)] : list.filter((s) => (s.senses.includes("temperature") || s.senses.includes("humidity")) && (!room || s.location?.toLowerCase() === room || s.name.toLowerCase().includes(room)));
      if (!picked.length) return fail("not_found", room ? `no climate sensor in "${a.room}"` : "no climate sensors");
      const from = new Date(Date.now() - 3600_000).toISOString();
      const out = [];
      for (const s of picked) {
        const now = await client.sources.now(s.id);
        const history = (await client.sources.history(s.id, { from })).data;
        const readings = (now.readings ?? []).map((r) => {
          const series = history.filter((h) => h.sense === r.sense);
          const first = series[0]?.value;
          const delta = first === undefined ? 0 : r.value - first;
          const trend = Math.abs(delta) < (r.sense === "humidity" ? 2 : 0.3) ? "steady" : delta > 0 ? "rising" : "falling";
          return { sense: r.sense, value: r.value, unit: r.unit, measured_at: r.measured_at, trend_last_hour: trend, change_last_hour: Math.round(delta * 10) / 10 };
        });
        out.push({ source: s.id, name: s.name, location: s.location, readings });
      }
      return text({ sources: out });
    },

    async watch_for(a) {
      const ids = [];
      for (const s of (a.sources as unknown[]) ?? []) ids.push((await resolve(s)).id);
      // An agent's own watches report to its inbox (ADR 0043) unless it asks for the account's webhooks.
      const self = a.notify_me === false ? null : await agentId();
      const w = await client.watches.create({
        instruction: String(a.condition), sources: ids, ...(a.duration_minutes ? { duration_minutes: Number(a.duration_minutes) } : {}),
        ...(self ? { notify: [{ type: "agent" as const, id: self }] } : {}),
        ...(a.active_hours ? { active_hours: a.active_hours as { from: string; to: string } } : {}),
      });
      return text({ watch_id: w.id, sources: w.sources, status: w.status, compiled: w.compiled, warnings: w.warnings, estimate: w.estimate, expires_at: w.expires_at ?? null,
        active_hours: w.active_hours ?? null, notify: w.notify ?? [],
        note: self
          ? "Events come to your inbox: what_happened returns new ones first, and clients that accept notifications are told when they arrive."
          : "Events go to the account's webhooks; call what_happened to check." });
    },

    async what_happened(a) {
      const q = String(a.question);
      const src = a.source ? await resolve(a.source) : undefined;
      // New events from this agent's watches come first, then are marked seen.
      let inbox: ReturnType<typeof inboxBrief>[] = [];
      if (await agentId()) {
        const items = (await client.inbox.list({ unseen: true, limit: 50 })).data.filter((i) => !src || i.event.source.id === src.id);
        if (items.length) await client.inbox.markSeen({ ids: items.map((i) => i.id) });
        inbox = items.map((i) => ({ ...inboxBrief(i), ...(i.event.media ?? {}) }));
      }
      const r = await client.memory.search({ q, limit: 10, ...(a.from ? { from: String(a.from) } : {}), ...(a.to ? { to: String(a.to) } : {}) });
      let hits = r.data;
      if (src) hits = hits.filter((h) => h.event.source.id === src.id);
      return text({ question: q, ...(inbox.length ? { new_from_your_watches: inbox } : {}), events: hits.map((h) => ({ ...brief(h.event), score: Math.round(h.score * 1000) / 1000 })) });
    },

    async replay(a) {
      const src = await resolve(a.source);
      const range = { from: String(a.from), to: String(a.to) };
      const p = await client.sources.playback(src.id, range);
      const clip = a.save ? await client.clips.create({ source: src.id, ...range }) : undefined;
      return text({ source: src.id, url: p.url, expires_at: p.expires_at, gaps: p.gaps ?? [], ...(clip ? { clip_id: clip.id } : {}) });
    },

    async stop_watching(a) {
      await client.watches.delete(String(a.watch_id));
      return text({ stopped: String(a.watch_id) });
    },
  };

  return async (name: string, args: Args): Promise<CallToolResult> => {
    const h = handlers[name];
    if (!h) return fail("not_found", `unknown tool ${name}`);
    // One span per tool call (ADR 0033); its API calls are children through the SDK's fetch.
    // Arguments and results are not recorded (they may contain questions about people).
    return withSpan(`mcp.tool ${name}`, { kind: SpanKind.SERVER, attributes: { "gen_ai.tool.name": name, "rpc.system": "mcp" } }, async (span) => {
      try {
        return await h(args ?? {});
      } catch (err) {
        const code = err instanceof SenseplaneError ? err.code : "internal";
        span.setAttribute("senseplane.error_code", code);
        span.setStatus({ code: SpanStatusCode.ERROR, message: code });
        if (err instanceof SenseplaneError) return fail(err.code, err.message);
        return fail("internal", (err as Error).message);
      }
    });
  };
}

/** An MCP server bound to one caller's Senseplane credentials. */
export function createMcpServer(client: Senseplane, fetchImpl?: typeof fetch): Server {
  // logging and resources carry inbox notifications (ADR 0043, inbox.ts).
  const server = new Server({ name: "senseplane", version: "0.3.0" }, { capabilities: { tools: {}, logging: {}, resources: { subscribe: true } } });
  const call = createHandlers(client, fetchImpl);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as { type: "object" } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => call(req.params.name, (req.params.arguments ?? {}) as Args));
  const subs = new Set<string>();
  subscriptions.set(server, subs);
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: INBOX_URI, name: "inbox", mimeType: "application/json", description: "New events your watches sent you (not yet read with what_happened)." }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== INBOX_URI) throw new Error(`unknown resource ${req.params.uri}`);
    const items = await client.inbox.list({ unseen: true, limit: 50 }).then((r) => r.data.map(inboxBrief), () => []);
    return { contents: [{ uri: INBOX_URI, mimeType: "application/json", text: JSON.stringify({ events: items }, null, 2) }] };
  });
  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subs.add(req.params.uri);
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subs.delete(req.params.uri);
    return {};
  });
  return server;
}
