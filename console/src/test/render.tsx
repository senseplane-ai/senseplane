// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Renders a page inside the console providers with a fake API. Tests pass the
// pieces of AppData they need; everything else gets harmless defaults.
import { type RenderResult, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { Senseplane, type Source } from "senseplane";
import { ApiExtra, DEFAULT_LIMITS } from "../api/extra";
import { type AppData, AppDataContext } from "../shell/AppData";
import { ToastProvider } from "../ui";

export function source(over: Partial<Source> = {}): Source {
  return {
    id: "src_01HZZZZZZZZZZZZZZZZZZZZZZZ", name: "Front door", type: "browser", senses: ["video", "audio"], status: "online",
    record_audio: false, zones: [], privacy_masks: [], created_at: "2026-10-16T08:00:00.000Z", retention_days: null, ...over,
  } as Source;
}

/** A fetch that answers from a route table: { "GET /sources": body | (req) => Response }. Unknown routes 404. */
export function fakeFetch(routes: Record<string, unknown | ((url: URL, init?: RequestInit) => Response | Promise<Response>)>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://test");
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const path = url.pathname.replace(/^\/api\/v1/, "").replace(/^\/v1/, "");
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) return new Response(JSON.stringify({ error: { code: "not_found", message: "Route not found" } }), { status: 404, headers: { "content-type": "application/json" } });
    if (typeof hit === "function") return hit(url, init);
    return new Response(JSON.stringify(hit), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

export function appData(over: Partial<AppData> & { fetch?: typeof fetch } = {}): AppData {
  const f = over.fetch ?? fakeFetch({});
  const extra = new ApiExtra("http://test/v1", "sk_test", f);
  const client = new Senseplane({ apiKey: "sk_test", baseUrl: "http://test/v1", fetch: f });
  return {
    apiUrl: "/api/v1", apiKey: "sk_test", client, extra,
    sources: [], refreshSources: async () => {}, putSource: () => {},
    account: { id: "acc_1", name: "Northwind Ops", retention_days: 7 }, limits: DEFAULT_LIMITS, me: null,
    conversations: [], chatsAvailable: true, refreshConversations: async () => {},
    unreadEvents: 0, markEventsSeen: () => {}, signOut: () => {},
    ...over,
  };
}

export function renderWithApp(ui: ReactNode, data: AppData = appData()): RenderResult {
  return render(
    <ToastProvider>
      <AppDataContext.Provider value={data}>{ui}</AppDataContext.Provider>
    </ToastProvider>,
  );
}
