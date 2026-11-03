// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The 15 tools, each a thin call into the public API through the TypeScript
// SDK. Results are short JSON text for the model plus, for `look`, the image
// itself so the agent can see it.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema, type CallToolResult, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
  SubscribeRequestSchema, UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { isSensorSense, readingText, Senseplane, SenseplaneError, senseName } from "senseplane";
import { INBOX_URI, inboxBrief, subscriptions } from "./inbox.js";
import { tools } from "./tools.js";
import { SpanKind, SpanStatusCode, withSpan } from "@senseplane/telemetry";

type Args = Record<string, unknown>;
type Source = { id: string; name: string; location?: string; type: string; senses: string[]; status: string; speaker?: boolean };
type SpeakMessage = { id: string; source_id: string; status: string; message?: string | null; duration_ms?: number | null; clip_url?: string | null };
/** What an agent needs to know about a message it said (ADR 0069). */
const said = (m: SpeakMessage) => ({
  message_id: m.id, source: m.source_id, status: m.status, ...(m.message ? { message: m.message } : {}),
  ...(m.duration_ms ? { duration_ms: m.duration_ms } : {}), ...(m.clip_url ? { clip_url: m.clip_url } : {}),
  ...(m.status === "playing" ? { note: "It is playing on the camera now, after a short chime." } : {}),
  ...(m.status === "sent" ? { note: "The camera's box has it; it hasn't said it has played it yet." } : {}),
});

const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (code: string, message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] });

/** Polls `get` until `done` holds or `ms` pass (0.5 s at first, then up to every 3 s); returns the last answer. */
async function until<T>(get: () => Promise<T>, done: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  let wait = 500;
  for (;;) {
    const v = await get();
    if (done(v) || Date.now() + wait > end) return v;
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(3000, wait * 2);
  }
}

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

  type DeviceRow = { id: string; name: string; room: string | null; type: string; tier: string; actions: string[]; state: unknown; online: boolean; can_control: boolean; controllable: boolean };
  /** A device by id or (case-insensitive) name, with or without its room. */
  const device = async (ref: unknown): Promise<DeviceRow> => {
    const r = String(ref ?? "").trim().toLowerCase();
    const list = (await client.devices.list()) as DeviceRow[];
    const hit = list.find((d) => d.id.toLowerCase() === r) ?? list.find((d) => d.name.toLowerCase() === r) ?? list.find((d) => `${d.room ?? ""} ${d.name}`.trim().toLowerCase() === r);
    if (!hit) throw new SenseplaneError(404, "not_found", `no device "${String(ref)}"; call list_devices for the ids`);
    return hit;
  };
  const request = (c: { id: string; device_name: string; action: string; status: string; message: string; state: unknown; expires_at: string | null }) =>
    ({ request: c.id, device: c.device_name, action: c.action, status: c.status, message: c.message, state: c.state, ...(c.expires_at && c.status === "awaiting_confirmation" ? { confirm_by: c.expires_at } : {}) });

  const handlers: Record<string, (a: Args) => Promise<CallToolResult>> = {
    async list_devices(a) {
      const room = a.room ? String(a.room).toLowerCase() : undefined;
      const list = ((await client.devices.list()) as DeviceRow[]).filter((d) => !room || d.room?.toLowerCase() === room);
      return text({ devices: list.map((d) => ({ id: d.id, name: d.name, room: d.room, type: d.type, tier: d.tier, actions: d.actions, state: d.state, online: d.online, can_control: d.can_control })) });
    },

    async control_device(a) {
      if (a.request) return text(request(await client.devices.request(String(a.request))));
      if (!a.device || !a.action) return fail("validation_failed", "give a device and an action, or a request id to check");
      const d = await device(a.device);
      try {
        const c = await client.devices.command(d.id, { action: String(a.action) as never, ...(a.value !== undefined ? { value: a.value as number | string } : {}) });
        return text({ ...request(c), ...(c.status === "awaiting_confirmation" ? { note: "A person must confirm this in Senseplane (console, app or Telegram) within 2 minutes; it hasn't happened yet." } : {}) });
      } catch (err) {
        // Offline boxes, failures and refusals carry the recorded request.
        const cmd = err instanceof SenseplaneError ? (err.details?.command as Parameters<typeof request>[0] | undefined) : undefined;
        if (cmd) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: (err as SenseplaneError).code, message: (err as Error).message }, ...request(cmd) }, null, 2) }] };
        throw err;
      }
    },

    async list_senses() {
      const list = await sources();
      return text({ sources: list.map((s) => ({ id: s.id, name: s.name, location: s.location, type: s.type, senses: s.senses, status: s.status, ...(s.speaker ? { speaker: true } : {}) })) });
    },

    async speak(a) {
      const src = await resolve(a.source);
      const words = String(a.text ?? "").trim();
      if (!words) return fail("validation_failed", "give the text to say");
      try {
        return text(said((await client.sources.speak(src.id, words)) as SpeakMessage));
      } catch (err) {
        // Refused, offline and too long carry the recorded message.
        const m = err instanceof SenseplaneError ? (err.details?.message as SpeakMessage | undefined) : undefined;
        if (m) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: (err as SenseplaneError).code, message: (err as Error).message }, ...said(m) }, null, 2) }] };
        throw err;
      }
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
      const only = a.sense ? String(a.sense) : undefined;
      const sensing = (s: { senses: string[] }) => s.senses.some((x) => isSensorSense(x) && (!only || x === only));
      const picked = a.source ? [await resolve(a.source)] : list.filter((s) => sensing(s) && (!room || s.location?.toLowerCase() === room || s.name.toLowerCase().includes(room)));
      if (!picked.length) return fail("not_found", `no ${only ? senseName(only) : ""} sensor${only ? "" : "s"}${room ? ` in "${a.room}"` : ""}`.replace("no  ", "no "));
      const from = new Date(Date.now() - 3600_000).toISOString();
      const out = [];
      for (const s of picked) {
        const now = await client.sources.now(s.id);
        const latest = (now.readings ?? []).filter((r) => !only || r.sense === only);
        const history = latest.some((r) => r.kind === "number" || r.kind === undefined) ? (await client.sources.history(s.id, { from })).data : [];
        const readings = latest.map((r) => {
          const device = r.device ? { device: r.device.name ?? r.device.id } : {};
          if (r.kind === "state") return { sense: r.sense, ...device, state: r.state, value: r.value, since: r.since, measured_at: r.measured_at };
          if (r.kind === "event") return { sense: r.sense, ...device, last: readingText(r), ...(r.detail ? { detail: r.detail } : {}), at: r.measured_at };
          const value = Number(r.value);
          const series = history.filter((h) => h.sense === r.sense && h.device?.id === r.device?.id);
          const first = series[0]?.value;
          const delta = typeof first === "number" ? value - first : 0;
          // "Steady" is a small change for the unit: 0.3 °C, 2 points of a percentage, else 5 %.
          const still = r.unit === "celsius" ? 0.3 : r.unit === "percent" ? 2 : Math.max(Math.abs(value) * 0.05, 0.01);
          const trend = Math.abs(delta) < still ? "steady" : delta > 0 ? "rising" : "falling";
          return { sense: r.sense, ...device, value, unit: r.unit, text: readingText(r), measured_at: r.measured_at, trend_last_hour: trend, change_last_hour: Math.round(delta * 10) / 10 };
        });
        // A box that is off (or can't reach Home Assistant) left these values behind: say so, never pass them off as now.
        const offline = s.status === "offline" || s.status === "reconnecting";
        out.push({ source: s.id, name: s.name, location: s.location, ...(offline ? { status: "offline", note: `Offline since ${(s as { status_since?: string }).status_since ?? "a while"}: these are the last readings, not what is true now.` } : {}), readings });
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
        mode: a.mode === "track" ? "track" : "alert",
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

    async measure(a) {
      // The API does the arithmetic (ADR 0057); source names are resolved there, within this caller's grants.
      const r = await client.activity.query(a as unknown as Parameters<typeof client.activity.query>[0]);
      return text(r);
    },

    async check_history(a) {
      const ids = [];
      for (const s of (a.sources as unknown[]) ?? []) ids.push((await resolve(s)).id);
      const r = await client.activity.check({
        ...(a.instruction ? { instruction: String(a.instruction) } : {}), ...(a.watch_id ? { watch_id: String(a.watch_id) } : {}),
        ...(ids.length ? { sources: ids } : {}), ...(a.from ? { from: String(a.from) } : {}), ...(a.to ? { to: String(a.to) } : {}),
        ...(a.max_checks !== undefined ? { max_checks: Number(a.max_checks) } : {}),
      });
      return text({ matches: r.matches, checks_used: r.checks_used, candidates: r.candidates, unchecked: r.unchecked, stored: r.stored });
    },

    async replay(a) {
      const src = await resolve(a.source);
      const range = { from: String(a.from), to: String(a.to) };
      const p = await client.sources.playback(src.id, range);
      const clip = a.save ? await client.clips.create({ source: src.id, ...range }) : undefined;
      return text({ source: src.id, url: p.url, expires_at: p.expires_at, gaps: p.gaps ?? [], ...(clip ? { clip_id: clip.id } : {}) });
    },

    async make_story(a) {
      // Moments by event id or by source (name or id) and range; or a search, as what_happened does (ADR 0070).
      const moments = [];
      for (const m of (a.moments as Args[] | undefined) ?? []) {
        moments.push(m.event ? { event: String(m.event) } : { source: (await resolve(m.source)).id, from: String(m.from), to: String(m.to) });
      }
      const ids = [];
      for (const s of (a.sources as unknown[]) ?? []) ids.push((await resolve(s)).id);
      const created = await client.stories.create({
        ...(moments.length ? { moments } : {}),
        ...(a.search ? { search: { q: String(a.search), ...(a.from ? { from: String(a.from) } : {}), ...(a.to ? { to: String(a.to) } : {}), ...(ids.length ? { sources: ids } : {}) } } : {}),
        ...(a.title ? { title: String(a.title) } : {}), ...(a.fast ? { mode: "fast" as const } : {}),
      });
      const story = await until(() => client.stories.get(created.id), (s) => s.status === "ready" || s.status === "failed", 120_000);
      return text({
        story_id: story.id, status: story.status, ...(story.error ? { error: story.error } : {}),
        pieces: story.pieces.map((p) => ({ source: p.source_name, from: p.from, to: p.to, ...(p.recorded_ms === 0 ? { note: "nothing recorded" } : {}) })),
        ...(story.playback_url ? { url: story.playback_url, expires_at: story.playback_expires_at, duration_ms: story.duration_ms } : {}),
        ...(story.status !== "ready" && story.status !== "failed" ? { note: "still rendering: get it later by its story id (GET /v1/stories/{id})" } : {}),
      });
    },

    async follow_object(a) {
      // Objects and pets only: the API refuses a person (ADR 0070).
      const ids = [];
      for (const s of (a.sources as unknown[]) ?? []) ids.push((await resolve(s)).id);
      const created = await client.follows.create({
        reference: { ...(a.event ? { event: String(a.event) } : {}), ...(a.box ? { box: (a.box as unknown[]).map(Number) } : {}), ...(a.description ? { description: String(a.description) } : {}) },
        from: String(a.from), to: String(a.to), ...(ids.length ? { sources: ids } : {}), make_story: a.make_story !== false,
      });
      const f = await until(() => client.follows.get(created.id), (x) => ["done", "failed", "refused"].includes(x.status), 150_000);
      const r = f.result;
      return text({
        follow_id: f.id, status: f.status, ...(f.error ? { error: f.error } : {}),
        ...(r ? {
          route: (r.route ?? []).map((v) => ({ source: v.source_name, from: v.from, to: v.to, confidence: v.confidence, ...(v.playback_url ? { url: v.playback_url } : {}) })),
          handovers: r.handovers ?? [], gaps: r.gaps ?? [], frames_examined: f.frames_examined, model_calls: f.model_calls,
        } : {}),
        ...(f.story_id ? { story_id: f.story_id } : {}),
      });
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
  const server = new Server({ name: "senseplane", version: "0.4.0" }, { capabilities: { tools: {}, logging: {}, resources: { subscribe: true } } });
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
