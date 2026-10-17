// @vitest-environment jsdom
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsagePage, periodTitle } from "./UsagePage";
import { SRC, setup, sources } from "./test-utils";

const today = new Date().toISOString().slice(0, 10);
const usage = {
  period: { from: "2026-10-01T00:00:00Z", to: "2026-10-16T12:00:00Z" },
  camera_minutes: 41220, camera_minutes_by_resolution: { "720p": 41220 }, camera_minutes_by_source: { [SRC.front]: 7420, [SRC.dock]: 6900 },
  storage_gb_hours: 1000, ai_checks: 1904, ai_checks_by_kind: { verify: 1610, ask: 200, look: 94 },
  sources: { registered: 3, active: 2 }, recording_hours: 687, storage_gb_days: 41, frames_analysed: 1, vlm_calls: 1, live_view_minutes: 2140,
  by_day: [{ day: "2026-10-14", camera_minutes: 2400, ai_checks: 90 }, { day: "2026-10-15", camera_minutes: 2600, ai_checks: 150 }, { day: today, camera_minutes: 1200, ai_checks: 10 }],
};
const account = { id: "acc_1", name: "Northwind", retention_days: 7, retention_max_days: null, retention_mode: "days", created_at: "2026-01-01T00:00:00Z", storage: { raw_bytes: 38e9, clip_bytes: 0, snapshot_bytes: 0 } };

describe("UsagePage", () => {
  it("shows meters as unlimited on a self-hosted server and no plan card", async () => {
    const { props } = setup({ "GET /usage": usage, "GET /account": account, "GET /sources": sources() });
    render(<UsagePage {...props} />);
    const meters = await screen.findByRole("region", { name: "Allowances" });
    expect(within(meters).getByText("41,220")).toBeTruthy();
    expect(within(meters).getAllByText(/of unlimited/).length).toBeGreaterThanOrEqual(3);
    expect(within(meters).getByText("Watches 1,610 · questions 294")).toBeTruthy();
    expect(within(meters).queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/come from your plan/)).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^1 – 31 /);
  });

  it("shows limits, progress and the plan card when the deployment supplies them", async () => {
    const limits = { live_view: true, live_view_minutes: 10000, max_live_viewers: 3, camera_minutes: 80000, storage_gb: 120, ai_checks: 5000 };
    const { props } = setup({ "GET /usage": usage, "GET /account": { ...account, limits, plan_label: "Team" }, "GET /sources": sources() });
    render(<UsagePage {...props} />);
    expect(await screen.findByText("Team")).toBeTruthy();
    expect(screen.getByText(/of 80,000/)).toBeTruthy();
    expect(screen.getByText("Viewer-minutes · up to 3 people at once")).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(4);
  });

  it("switches the daily chart metric accessibly and lists cameras", async () => {
    const { props } = setup({ "GET /usage": usage, "GET /account": account, "GET /sources": sources() });
    render(<UsagePage {...props} />);
    const chart = await screen.findByRole("img", { name: /Camera minutes per day/ });
    expect(chart.children).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "AI checks" }));
    expect(screen.getByRole("img", { name: /AI checks per day.*highest 150/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "AI checks" }).getAttribute("aria-pressed")).toBe("true");
    const rows = await screen.findAllByRole("row");
    expect(rows.some((r) => r.textContent?.includes("Front door") && r.textContent.includes("7,420"))).toBe(true);
  });

  it("shows the locked live view meter when live view is off", async () => {
    const limits = { live_view: false, live_view_minutes: null, max_live_viewers: null, camera_minutes: null, storage_gb: null, ai_checks: null };
    const { props } = setup({ "GET /usage": usage, "GET /account": { ...account, limits }, "GET /sources": sources() });
    render(<UsagePage {...props} />);
    expect(await screen.findByText("Live view isn't included in this workspace")).toBeTruthy();
  });

  it("explains when usage is not available", async () => {
    const { props } = setup({ "GET /sources": sources() });
    render(<UsagePage {...props} />);
    expect(await screen.findByText(/Usage isn't available on this server yet/)).toBeTruthy();
  });

  it("titles the period", () => {
    expect(periodTitle("2026-10-01T00:00:00", "2026-10-16T00:00:00")).toBe(`1 – 31 ${new Date(2026, 9, 1).toLocaleDateString(undefined, { month: "long" })}`);
  });
});
