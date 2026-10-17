// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// An in-page fake of the Senseplane API for the console e2e when no compose
// stack is running. It follows spec/openapi.yaml and the console build
// contracts closely enough to drive every screen; it is not a second backend.
import type { Page, Route } from "@playwright/test";

type Json = Record<string, unknown>;

const scene = (hue: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" width="640" height="360">
<rect width="160" height="90" fill="hsl(${hue} 6% 12%)"/><path d="M0 68 L44 50 L106 55 L160 38 L160 90 L0 90 Z" fill="hsl(${hue} 5% 17%)"/>
<rect x="96" y="14" width="30" height="40" fill="none" stroke="hsl(${hue} 5% 22%)"/><rect x="66" y="26" width="18" height="44" rx="6" fill="hsl(${hue} 4% 26%)"/></svg>`;

export interface FakeState {
  sources: Json[];
  events: Json[];
  watches: Json[];
  clips: Json[];
  conversations: (Json & { messages: Json[] })[];
  liveView: boolean;
  signedUp: boolean;
  agents: Json[];
  grants: Json[];
}

const ulid = () => Array.from({ length: 26 }, () => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)]).join("");
const id = (p: string) => `${p}_${ulid()}`;
const iso = (ms: number) => new Date(ms).toISOString();

export function makeSource(over: Json): Json {
  return {
    id: id("src"), type: "browser", senses: ["video"], status: "online", record_audio: false, zones: [], privacy_masks: [],
    created_at: iso(Date.now() - 86400_000), retention_days: null, retention_mode: null, max_resolution: "720p", view_changed_at: null, ...over,
  };
}

/** Adds a few cameras, a sensor and today's events so the screens look lived-in. */
export function seed(state: FakeState) {
  const day = new Date(); day.setHours(0, 0, 0, 0);
  state.sources.push(
    makeSource({ name: "Reception", location: "Lobby", type: "whip" }),
    makeSource({ name: "Loading dock", location: "Warehouse", type: "whip", status: "offline", senses: ["video", "audio"] }),
    makeSource({ name: "Warehouse aisle 3", location: "Warehouse", type: "whip" }),
    makeSource({ name: "Server room", location: "Office", type: "sensor", senses: ["temperature", "humidity"] }),
  );
  const video = state.sources.filter((s) => (s.senses as string[]).includes("video"));
  const now = Date.now();
  let t = Math.max(day.getTime() + 7 * 3600_000, now - 9 * 3600_000);
  for (let i = 0; t < now - 60_000 && i < 14; i++, t += 40 * 60_000) {
    const s = video[i % video.length]!;
    const watch = i % 4 === 3;
    state.events.push({
      id: id("evt"), type: watch ? "watch.triggered" : "detection.person", source: { id: s.id, sense: "video", location: s.location },
      occurred_at: iso(t), summary: watch ? "Someone is waiting at the front door." : "A person was seen.", labels: ["person"],
      confidence: 0.86 + (i % 10) / 100, verified: watch ? true : null, value: null, media: { snapshot_url: `/api/fake/snapshot/${i}.svg` },
    });
  }
  state.watches.push({
    id: id("wat"), instruction: "Tell me when someone is at the front door", sources: [video[0]!.id], mode: "alert",
    compiled: { trigger: { type: "object_enters", labels: ["person"] }, verify: { prompt: "someone at the door", min_confidence: 0.7 }, cooldown_s: 60, active_hours: null },
    estimate: { vlm_calls_per_day: "5-20" }, status: "active", warnings: [], created_at: iso(now - 86400_000), expires_at: null,
  });
}

export async function installFakeApi(page: Page): Promise<FakeState> {
  const state: FakeState = { sources: [], events: [], watches: [], clips: [], conversations: [], liveView: true, signedUp: false, agents: [], grants: [] };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const notFound = (route: Route, message = "not found") => json(route, { error: { code: "not_found", message } }, 404);
  const page1 = <T>(data: T[]) => ({ data, next_cursor: null });

  await page.route((u) => u.pathname.startsWith("/api/"), async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, "");
    const method = req.method();
    const body = (): Json => { try { return (req.postDataJSON() ?? {}) as Json; } catch { return {}; } };

    const snap = path.match(/^\/fake\/snapshot\/(\d+)\.svg$/);
    if (snap) return route.fulfill({ contentType: "image/svg+xml", body: scene(Number(snap[1]) * 37 % 360) });

    if (path === "/auth/providers") return json(route, { password: true, google: false, github: false, signup: true, challenge: null });
    if (path === "/auth/signup" && method === "POST") {
      const b = body();
      if (String(b.password ?? "").length < 10) return json(route, { error: { code: "validation_failed", message: "body/password must NOT have fewer than 10 characters" } }, 400);
      state.signedUp = true;
      return json(route, { session: "sk_e2e_session", expires_at: iso(Date.now() + 30 * 86400_000), account_id: "acc_e2e" }, 201);
    }
    if (path === "/auth/login") return json(route, { session: "sk_e2e_session" });
    if (path === "/auth/logout") return route.fulfill({ status: 204 });

    let m: RegExpMatchArray | null;
    if (path === "/v1/account") {
      return json(route, { id: "acc_e2e", name: "Northwind Ops", retention_days: 7, retention_max_days: null, retention_mode: "days", created_at: iso(Date.now()), limits: { live_view: state.liveView, live_view_minutes: 10000, max_live_viewers: 3, camera_minutes: null, storage_gb: null, ai_checks: null } });
    }
    if (path === "/v1/me") return json(route, { user: { id: "usr_e2e", email: "alex@northwind.example", name: "Alex Morgan" }, role: "owner", account: { id: "acc_e2e", name: "Northwind Ops" } });
    if (path === "/v1/usage") return json(route, { live_view_minutes: 2140, live_viewers_now: 1 });
    if (path === "/v1/sources" && method === "GET") return json(route, page1(state.sources));
    if (path === "/v1/sources" && method === "POST") {
      const b = body();
      const type = String(b.type);
      if (!["browser", "sensor", "whip"].includes(type)) return json(route, { error: { code: "validation_failed", message: "body/type must be equal to one of the allowed values" } }, 400);
      const s = makeSource({ name: b.name, location: b.location, type, status: "pending", record_audio: !!b.record_audio, senses: type === "sensor" ? ["temperature", "humidity"] : b.record_audio ? ["video", "audio"] : ["video"], created_at: iso(Date.now()) });
      state.sources.unshift(s);
      const ingest = type === "browser"
        ? { capture_url: `${url.origin}/capture.html#ticket=e2e-${s.id}`, token: "e2e", expires_at: iso(Date.now() + 600_000) }
        : type === "whip" ? { whip_url: `http://localhost:36090/whip/${s.id}`, token: "whp_e2e_token", expires_at: null } : undefined;
      return json(route, { ...s, ...(ingest ? { ingest } : {}) }, 201);
    }
    if ((m = path.match(/^\/v1\/sources\/([^/]+)$/))) {
      const s = state.sources.find((x) => x.id === m![1]);
      if (!s) return notFound(route, "source not found");
      if (method === "PATCH") Object.assign(s, body());
      else if (s.status === "pending") s.status = "online"; // the phone "connects" after the first look
      return json(route, s);
    }
    if ((m = path.match(/^\/v1\/sources\/([^/]+)\/now$/))) {
      const i = state.sources.findIndex((x) => x.id === m![1]);
      const s = state.sources[i];
      if (!s) return notFound(route);
      const sensor = s.type === "sensor";
      return json(route, {
        source_id: s.id, captured_at: iso(Date.now()),
        ...(sensor ? { readings: [{ sense: "temperature", value: 24.6, unit: "celsius", measured_at: iso(Date.now() - 60_000) }, { sense: "humidity", value: 41, unit: "percent", measured_at: iso(Date.now() - 60_000) }] } : { snapshot_url: `${url.origin}/api/fake/snapshot/${i}.svg` }),
      });
    }
    if ((m = path.match(/^\/v1\/sources\/([^/]+)\/timeline$/))) {
      const from = Date.parse(url.searchParams.get("from") ?? iso(Date.now() - 86400_000));
      const to = Date.parse(url.searchParams.get("to") ?? iso(Date.now()));
      const start = Math.max(from, to - 9 * 3600_000);
      const gap = start + (to - start) * 0.55;
      return json(route, { from: iso(from), to: iso(to), recorded: [{ from: iso(start), to: iso(gap) }, { from: iso(gap + 20 * 60_000), to: iso(to) }], gaps: [{ from: iso(gap), to: iso(gap + 20 * 60_000) }], retention_days: 7 });
    }
    if (path.match(/^\/v1\/sources\/[^/]+\/playback$/)) return notFound(route, "nothing was recorded in that range");
    if (path.match(/^\/v1\/sources\/[^/]+\/history$/)) return json(route, { data: [] });
    if (path.match(/^\/v1\/sources\/[^/]+\/capture-link$/)) return json(route, { ...state.sources[0], ingest: { capture_url: `${url.origin}/capture.html#ticket=new`, token: "x" } });
    if (path.match(/^\/v1\/sources\/[^/]+\/ask$/)) return json(route, { answer: "One person is standing at the door holding a phone.", confidence: 0.9, snapshot_url: `${url.origin}/api/fake/snapshot/1.svg` });
    if (path === "/v1/events") {
      const src = url.searchParams.get("source");
      const from = Date.parse(url.searchParams.get("from") ?? "1970-01-01");
      return json(route, page1(state.events.filter((e) => (!src || (e.source as Json).id === src) && Date.parse(String(e.occurred_at)) >= from).reverse()));
    }
    if (path === "/v1/watches" && method === "GET") return json(route, page1(state.watches));
    if (path === "/v1/watches" && method === "POST") {
      const w = { id: id("wat"), ...body(), mode: "alert", status: "active", warnings: [], created_at: iso(Date.now()), compiled: { trigger: {}, cooldown_s: 60, active_hours: null }, estimate: { vlm_calls_per_day: "1" } };
      state.watches.push(w);
      return json(route, w, 201);
    }
    if (path === "/v1/clips" && method === "POST") return json(route, { id: id("clp"), ...body() }, 201);
    if (path === "/v1/conversations" && method === "GET") return json(route, page1(state.conversations.map(({ messages: _m, ...c }) => c)));
    if (path === "/v1/conversations" && method === "POST") {
      const c = { id: id("cnv"), title: String(body().title ?? "New chat"), created_at: iso(Date.now()), updated_at: iso(Date.now()), messages: [] as Json[] };
      state.conversations.unshift(c);
      return json(route, c, 201);
    }
    if ((m = path.match(/^\/v1\/conversations\/([^/]+)$/))) {
      const c = state.conversations.find((x) => x.id === m![1]);
      return c ? json(route, c) : notFound(route);
    }
    if ((m = path.match(/^\/v1\/conversations\/([^/]+)\/messages$/))) {
      const c = state.conversations.find((x) => x.id === m![1]);
      if (!c) return notFound(route);
      const cam = state.sources.find((s) => (s.senses as string[]).includes("video"))!;
      const ev = state.events.filter((e) => (e.source as Json).id === cam.id).slice(-3);
      const moments = ev.map((e, i) => ({ source_id: cam.id, source_name: cam.name, at: e.occurred_at, label: ["Courier walks up", "Parcel left on the mat", "Parcel still there"][i] ?? "Person", snapshot_url: `${url.origin}/api/fake/snapshot/${i + 2}.svg` }));
      const answer = { id: id("msg"), role: "assistant", content: `A courier came to the **${String(cam.name).toLowerCase()}**. They left a parcel on the mat and were gone 40 seconds later. Nobody has picked it up yet.`, moments, suggested_watch: { instruction: `Tell me when a parcel is left at the ${String(cam.name).toLowerCase()}`, sources: [cam.id] }, created_at: iso(Date.now()) };
      c.messages.push({ id: id("msg"), role: "user", content: body().content, moments: [], created_at: iso(Date.now()) }, answer);
      const sse = [
        ["status", { text: `Looking at ${cam.name}…` }],
        ...String(answer.content).match(/.{1,24}/g)!.map((t) => ["delta", { text: t }]),
        ...moments.map((x) => ["moment", x]),
        ["suggested_watch", answer.suggested_watch],
        ["done", { message: answer }],
      ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: sse });
    }
    // Agents, grants and app consent (ADR 0048).
    if (path === "/v1/agents" && method === "GET") return json(route, page1(state.agents));
    if (path === "/v1/grants" && method === "GET") return json(route, page1(state.grants));
    if (path === "/v1/agents/connect" && method === "POST") {
      const b = body();
      let a = state.agents.find((x) => x.kind === "app" && x.client_name === b.client_name);
      if (!a) state.agents.push((a = { id: id("agt"), name: b.client_name, kind: "app", client_name: b.client_name, redirect_host: "localhost", key_prefix: "sk_ab12", created_at: iso(Date.now()) }));
      a.connected_at = iso(Date.now());
      a.last_active_at = null;
      state.grants = state.grants.filter((g) => g.agent_id !== a!.id);
      state.grants.push({ id: id("grt"), agent_id: a.id, source_ids: b.source_ids, senses: b.senses, abilities: b.abilities ?? ["watch", "history"], created_at: iso(Date.now()) });
      return json(route, { agent: a, code: "cc_e2e", expires_at: iso(Date.now() + 120_000), reused: false }, 201);
    }
    if ((m = path.match(/^\/v1\/agents\/([^/]+)$/)) && method === "DELETE") {
      state.agents = state.agents.filter((x) => x.id !== m![1]);
      state.grants = state.grants.filter((g) => g.agent_id !== m![1]);
      return route.fulfill({ status: 204 });
    }
    return notFound(route, `fake API has no ${method} ${path}`);
  });
  return state;
}
