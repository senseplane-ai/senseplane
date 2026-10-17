// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { navigate } from "../router";
import { appData, fakeFetch, renderWithApp, source } from "../test/render";
import { CameraPage } from "./Camera";
import { retentionBody } from "./camera/SettingsTab";
import { snapToRecorded } from "./camera/time";

const at = (h: number, m = 0) => new Date(2026, 9, 16, h, m).getTime();
const iso = (t: number) => new Date(t).toISOString();
const cam = source({ max_resolution: "720p", location: "Hallway" } as never);
const id = cam.id;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(15));
});
afterEach(() => vi.useRealTimers());

function routes(extra: Record<string, unknown> = {}) {
  return fakeFetch({
    [`GET /sources/${id}/timeline`]: { from: iso(at(0)), to: iso(at(15)), recorded: [{ from: iso(at(8)), to: iso(at(9)) }], gaps: [], retention_days: 7 },
    [`GET /sources/${id}/playback`]: { url: "http://test/p.m3u8", expires_at: iso(at(16)) },
    [`GET /sources/${id}/now`]: { source_id: id, captured_at: iso(at(14, 59)) },
    "GET /events": {
      data: [
        { id: "evt_1", type: "watch.triggered", watch_id: "wat_1", source: { id, sense: "video" }, occurred_at: iso(at(8, 30)), summary: "A parcel was left at the front door.", labels: [], confidence: 0.88, verified: true, value: null, media: {} },
        { id: "evt_2", type: "detection.person", source: { id, sense: "video" }, occurred_at: iso(at(8, 20)), summary: "A person was seen.", labels: [], confidence: 0.91, value: null, media: {} },
      ],
      next_cursor: null,
    },
    "GET /watches": { data: [], next_cursor: null },
    ...extra,
  });
}

it("renders the header, status line and tabs for a camera", async () => {
  renderWithApp(<CameraPage id={id} />, appData({ sources: [cam], fetch: routes() }));
  expect(screen.getByRole("heading", { level: 1, name: "Front door" })).toBeInTheDocument();
  expect(screen.getByText("Streaming")).toBeInTheDocument();
  expect(screen.getByText("Hallway")).toBeInTheDocument();
  expect(screen.getByText("Keeps 7 days")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Events" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("tab", { name: "Privacy masks" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Capture link" })).toBeInTheDocument();
  expect(await screen.findByText("A parcel was left at the front door.")).toBeInTheDocument();
  expect(screen.getByText("Verified · 0.88")).toBeInTheDocument();
});

it("draws markers on the timeline and seeks with the keyboard", async () => {
  const { container } = renderWithApp(<CameraPage id={id} />, appData({ sources: [cam], fetch: routes() }));
  const slider = screen.getByRole("slider", { name: /timeline/i });
  // Starts at the latest recording: two minutes before it ended.
  await waitFor(() => expect(screen.getByTestId("playhead-label")).toHaveTextContent("08:58"));
  expect(container.querySelectorAll(".cam-tl-watch")).toHaveLength(1);
  expect(container.querySelectorAll(".cam-tl-mark")).toHaveLength(2);
  slider.focus();
  fireEvent.keyDown(slider, { key: "ArrowLeft" });
  await waitFor(() => expect(screen.getByTestId("playhead-label")).toHaveTextContent("08:57"));
  fireEvent.keyDown(slider, { key: "ArrowLeft", shiftKey: true });
  await waitFor(() => expect(slider).toHaveAttribute("aria-valuetext", "08:47"));
});

it("opens at the deep-linked time from ?t=", async () => {
  history.replaceState(null, "", `/cameras/${id}?t=${encodeURIComponent(iso(at(8, 15)))}`);
  renderWithApp(<CameraPage id={id} />, appData({ sources: [cam], fetch: routes() }));
  await waitFor(() => expect(screen.getByTestId("playhead-label")).toHaveTextContent("08:15"));
  // Another result for the same camera moves the open player.
  act(() => navigate(`/cameras/${id}?t=${encodeURIComponent(iso(at(9, 40)))}`));
  await waitFor(() => expect(screen.getByTestId("playhead-label")).toHaveTextContent("09:40"));
});

it("saves a new name from the Settings tab", async () => {
  const putSource = vi.fn();
  const patch = vi.fn(async (_u: URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? (await (init as unknown as Request)?.text?.()) ?? "{}"));
    return new Response(JSON.stringify({ ...cam, ...body }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const f = routes({ [`PATCH /sources/${id}`]: patch });
  // openapi-fetch passes a Request; read its body for the assertion.
  const wrapped: typeof fetch = async (input, init) => {
    if (input instanceof Request && input.method === "PATCH") {
      return patch(new URL(input.url), { method: "PATCH", body: await input.text() });
    }
    return f(input, init);
  };
  renderWithApp(<CameraPage id={id} />, appData({ sources: [cam], fetch: wrapped, putSource }));
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  const name = screen.getByLabelText("Name");
  await user.clear(name);
  await user.type(name, "Porch{Enter}");
  await waitFor(() => expect(putSource).toHaveBeenCalledWith(expect.objectContaining({ name: "Porch" })));
  expect(patch).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Name saved.")).toBeInTheDocument();
});

it("shows not found for an unknown camera", async () => {
  renderWithApp(<CameraPage id="src_missing" />, appData({ sources: [cam], fetch: routes() }));
  expect(await screen.findByText("Camera not found")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to cameras" })).toHaveAttribute("href", "/cameras");
});

it("maps retention choices to the API body", () => {
  expect(retentionBody("default")).toEqual({ retention_days: null, retention_mode: null });
  expect(retentionBody("fill")).toEqual({ retention_mode: "fill", retention_days: null });
  expect(retentionBody("30")).toEqual({ retention_days: 30, retention_mode: "days" });
});

it("snaps a scrub in a gap to the next recording", () => {
  const ranges = [{ from: 100, to: 200 }, { from: 300, to: 400 }];
  expect(snapToRecorded(150, ranges)).toBe(150);
  expect(snapToRecorded(250, ranges)).toBe(300);
  expect(snapToRecorded(50, ranges)).toBe(100);
});
