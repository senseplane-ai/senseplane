// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// A fake Senseplane API for the admin page tests: routes like "GET /events"
// or "PATCH /watches/:id" answer with JSON; anything unrouted is a 404
// "route not found", like a server without that endpoint.
import { cleanup } from "@testing-library/react";
import { Senseplane } from "senseplane";
import { type Mock, afterEach, vi } from "vitest";

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  params: Record<string, string>;
}
export interface Reply {
  __reply: true;
  status: number;
  json?: unknown;
}
export const reply = (status: number, json?: unknown): Reply => ({ __reply: true, status, json });
export const notFound = () => reply(404, { error: { code: "not_found", message: "route not found", request_id: "r" } });
export const fail = (status: number, code: string, message = code) => reply(status, { error: { code, message, request_id: "r" } });

type Route = unknown | ((req: Req) => unknown);

export function fakeApi(routes: Record<string, Route>) {
  const calls: Req[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const text = await req.text();
    const path = url.pathname.replace(/^\/v1(?=\/)/, "");
    const r: Req = { method: req.method, path, query: url.searchParams, body: text ? JSON.parse(text) : undefined, params: {} };
    calls.push(r);
    let handler: Route | undefined;
    let found = false;
    for (const [k, v] of Object.entries(routes)) {
      const [m, pattern] = k.split(" ");
      if (m !== r.method) continue;
      const names: string[] = [];
      const re = new RegExp(`^${pattern!.replace(/:(\w+)/g, (_s, n: string) => { names.push(n); return "([^/]+)"; })}$`);
      const hit = path.match(re);
      if (hit) {
        names.forEach((n, i) => (r.params[n] = decodeURIComponent(hit[i + 1]!)));
        handler = v;
        found = true;
        break;
      }
    }
    let out: unknown = !found ? notFound() : typeof handler === "function" ? await (handler as (q: Req) => unknown)(r) : handler;
    if (!(out && typeof out === "object" && "__reply" in out)) out = reply(out === undefined ? 204 : 200, out);
    const { status, json } = out as Reply;
    return new Response(status === 204 ? null : JSON.stringify(json ?? {}), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetchFn, calls, called: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

export const API_URL = "http://sp.test/v1";

export function setup(routes: Record<string, Route>): { props: { client: Senseplane; apiUrl: string; apiKey: string; navigate: Mock<(path: string) => void> }; api: ReturnType<typeof fakeApi>; navigate: Mock<(path: string) => void> } {
  const api = fakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  const client = new Senseplane({ apiKey: "sk_test", baseUrl: API_URL, fetch: api.fetch as typeof fetch });
  const navigate = vi.fn<(path: string) => void>();
  return { props: { client, apiUrl: API_URL, apiKey: "sk_test", navigate }, api, navigate };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// --- fixtures -----------------------------------------------------------------

const ulid = (n: number) => String(n).padStart(26, "0");
export const page = <T>(data: T[], next_cursor: string | null = null) => ({ data, next_cursor });
export const me = (role: string) => ({ user: { id: "usr_1", email: "alex@example.com", name: "Alex" }, role, account: { id: "acc_1", name: "Northwind Ops" } });

export const SRC = { front: `src_${ulid(1)}`, dock: `src_${ulid(2)}`, lobby: `src_${ulid(3)}` };
export const source = (id: string, name: string) => ({
  id, name, type: "browser", senses: ["video"], status: "online", record_audio: false, zones: [], privacy_masks: [],
  created_at: "2026-10-01T00:00:00Z", retention_days: null, max_resolution: "720p",
});
export const sources = () => page([source(SRC.front, "Front door"), source(SRC.dock, "Loading dock"), source(SRC.lobby, "Reception")]);

export const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
export const event = (n: number, over: Record<string, unknown> = {}) => ({
  id: `evt_${ulid(n)}`, type: "detection.person", source: { id: SRC.front, sense: "video" }, occurred_at: isoAgo(n * 60_000),
  summary: `A person was seen ${n}.`, labels: ["person"], confidence: 0.9, value: null, media: { snapshot_url: `https://media.test/s/${n}.jpg` }, ...over,
});

export const watch = (n: number, over: Record<string, unknown> = {}) => ({
  id: `wat_${ulid(n)}`, instruction: `Watch number ${n}`, sources: [SRC.front], mode: "alert",
  compiled: { trigger: { type: "objects", label: "person", on: "enter" }, verify: { prompt: "Is someone at the door?", min_confidence: 0.6 }, cooldown_s: 300, active_hours: null },
  estimate: { vlm_calls_per_day: "5-20" }, status: "active", warnings: [], created_at: "2026-10-01T00:00:00Z", ...over,
});

export const webhook = (n: number, over: Record<string, unknown> = {}) => ({ id: `whk_${ulid(n)}`, url: `https://hooks${n}.example.com/in`, events: ["watch.triggered"], created_at: "2026-10-01T00:00:00Z", ...over });
export const agent = (n: number, name: string, over: Record<string, unknown> = {}) => ({ id: `agt_${ulid(n)}`, name, key_prefix: `sk_ab${n}`, created_at: "2026-10-02T00:00:00Z", ...over });
