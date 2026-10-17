// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { appData, fakeFetch, renderWithApp, source } from "../test/render";
import { CamerasPage } from "./Cameras";

const list = [
  source({ id: "src_a", name: "Front door", location: "Hallway", status: "online" }),
  source({ id: "src_b", name: "Loading dock", location: "Warehouse", status: "offline", type: "whip" }),
  source({ id: "src_c", name: "Server room", location: "Office", type: "sensor", senses: ["temperature"], status: "online" }),
];

const fetch = fakeFetch({
  "GET /sources/src_c/now": { source_id: "src_c", captured_at: "2026-10-16T16:04:00Z", readings: [{ sense: "temperature", value: 24.62, unit: "celsius", measured_at: "2026-10-16T16:04:00Z" }] },
  "GET /sources/src_a/now": { source_id: "src_a", captured_at: "2026-10-16T16:04:51Z", snapshot_url: "http://test/a.jpg" },
  "GET /events": { data: [{ id: "e1", type: "detection.person", source: { id: "src_a", sense: "video" }, occurred_at: new Date(Date.now() - 120_000).toISOString(), summary: "", labels: [], confidence: 0.9, value: null, media: {} }], next_cursor: null },
});

describe("CamerasPage", () => {
  it("shows a grid with latest frames, sensor readings and status", async () => {
    renderWithApp(<CamerasPage />, appData({ fetch, sources: list }));
    expect(screen.getByRole("heading", { name: "2 cameras, 1 sensor" })).toBeInTheDocument();
    expect(await screen.findByText("24.6 °C")).toBeInTheDocument();
    expect(await screen.findByAltText("Latest frame from Front door")).toHaveAttribute("src", "http://test/a.jpg");
    expect(await screen.findByText(/Person, 2 min ago/)).toBeInTheDocument();
    const dock = screen.getByRole("link", { name: /Loading dock/ });
    expect(within(dock).getByText("Offline")).toBeInTheDocument();
    expect(dock).toHaveAttribute("href", "/cameras/src_b");
  });

  it("filters by status and by name or place", async () => {
    renderWithApp(<CamerasPage />, appData({ fetch, sources: list }));
    await userEvent.click(screen.getByRole("button", { name: /Needs attention/ }));
    expect(screen.getByRole("button", { name: /Needs attention/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("link", { name: /Front door/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Loading dock/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^All/ }));
    await userEvent.type(screen.getByLabelText("Filter cameras"), "office");
    expect(screen.getAllByRole("link", { name: /Server room/ })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /Front door/ })).toBeNull();
  });

  it("switches to a scrollable table", async () => {
    renderWithApp(<CamerasPage />, appData({ fetch, sources: list }));
    await userEvent.click(screen.getByRole("button", { name: "List" }));
    const region = screen.getByRole("region", { name: "Cameras and sensors" });
    expect(within(region).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Status", "Senses", "Connected by", "Keeps", "Last event"]);
    expect(within(region).getAllByText("7 days")).toHaveLength(3);
    expect(within(region).getByText("WHIP")).toBeInTheDocument();
  });

  it("invites you to add a camera when there are none", () => {
    renderWithApp(<CamerasPage />, appData({ sources: [] }));
    expect(screen.getByRole("heading", { name: "No cameras yet" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Add camera" })[0]).toHaveAttribute("href", "/cameras/new");
  });
});
