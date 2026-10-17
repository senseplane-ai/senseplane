// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../api/extra";
import { appData, fakeFetch, renderWithApp, source } from "../test/render";
import { LiveViewPage } from "./LiveView";

const cams = Array.from({ length: 6 }, (_, i) => source({
  id: `src_01HZZZZZZZZZZZZZZZZZZZZZZ${i}`, name: `Cam ${i + 1}`, status: i === 2 ? "offline" : "online", location: i < 3 ? "Warehouse" : "Office",
}));

function setup(opts: { limits?: Partial<typeof DEFAULT_LIMITS>; usage?: unknown } = {}) {
  const calls: string[] = [];
  const fetch = fakeFetch({
    "GET /usage": opts.usage ?? { live_view_minutes: 2140, live_viewers_now: 1 },
    "GET /events": { data: [], next_cursor: null },
    "POST /clips": { id: "clp_1" },
  });
  const tracked: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (/\/sources\/[^/]+\/now$/.test(new URL(url, "http://test").pathname)) {
      return new Response(JSON.stringify({ source_id: "x", captured_at: new Date().toISOString(), snapshot_url: "http://test/snap.jpg" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return fetch(input, init);
  };
  const data = appData({ fetch: tracked, sources: cams, limits: { ...DEFAULT_LIMITS, ...opts.limits } });
  renderWithApp(<LiveViewPage />, data);
  return { calls };
}

describe("Live view", () => {
  it("shows the locked state and requests no video when live view is off", async () => {
    const { calls } = setup({ limits: { live_view: false } });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Live view");
    expect(screen.getByText("Live view isn't included in this workspace")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See usage" })).toHaveAttribute("href", "/usage");
    expect(screen.getByRole("link", { name: "Replay recordings" })).toHaveAttribute("href", "/cameras");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.some((u) => u.includes("/now"))).toBe(false);
    expect(screen.queryByRole("button", { name: /Open .* large/ })).toBeNull();
  });

  it("shows tiles and falls back to the latest snapshot when live video isn't available", async () => {
    setup();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("5 of 6 cameras live");
    expect(screen.getAllByRole("button", { name: /Open .* large/ })).toHaveLength(6);
    await waitFor(() => expect(screen.getAllByText("SNAPSHOT").length).toBeGreaterThan(0));
    expect(screen.queryByText("LIVE")).toBeNull();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("img.lv-media")).not.toBeNull());
  });

  it("changes the number of tiles with the layout and the group", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Four cameras" }));
    expect(screen.getAllByRole("button", { name: /Open .* large/ })).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "One camera" }));
    expect(screen.getAllByRole("button", { name: /Open .* large/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Up to nine cameras" }));
    fireEvent.change(screen.getByLabelText("Camera group"), { target: { value: "Office" } });
    expect(screen.getAllByRole("button", { name: /Open .* large/ })).toHaveLength(3);
  });

  it("opens a camera large and returns with Escape or the back button", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Open Cam 1 large" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Cam 1");
    expect(screen.getByRole("link", { name: "Rewind 1 minute" }).getAttribute("href")).toMatch(/^\/cameras\/src_.+\?t=/);
    expect(screen.getByRole("link", { name: "Ask about this camera" }).getAttribute("href")).toMatch(/^\/\?camera=src_/);
    expect(screen.getByRole("button", { name: "Unmute" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Cam 2 large" }));
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Cam 2");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("5 of 6 cameras live");
    fireEvent.click(screen.getByRole("button", { name: "Open Cam 1 large" }));
    fireEvent.click(screen.getByRole("button", { name: "← All cameras" }));
    expect(screen.getAllByRole("button", { name: /Open .* large/ })).toHaveLength(6);
  });

  it("shows viewer-minutes against a numeric limit", async () => {
    setup({ limits: { live_view_minutes: 10000, max_live_viewers: 3 } });
    await waitFor(() => expect(screen.getByText(/of 10,000 viewer-minutes this month/)).toBeInTheDocument());
    expect(screen.getByText("2,140")).toBeInTheDocument();
    expect(screen.getByText(/of 3 people watching now/)).toBeInTheDocument();
    expect(screen.getByRole("meter")).toBeInTheDocument();
  });

  it("shows plain viewer-minutes when unlimited, and the note even without usage", async () => {
    setup();
    await waitFor(() => expect(screen.getByText(/viewer-minutes this month/)).toHaveTextContent("2,140 viewer-minutes this month"));
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText(/person watching now/)).toHaveTextContent("1 person watching now"); // no cap: a plain count
    expect(screen.getByText(/Pauses after 10 idle minutes/)).toBeInTheDocument();
  });
});
