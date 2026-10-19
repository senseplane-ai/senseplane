// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { navigate } from "../router";
import { appData, fakeFetch, renderWithApp, source } from "../test/render";
import { CameraPage } from "./Camera";
import { durationText } from "./camera/ActivityTab";
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

it("lists today's activity with durations, ongoing and checked later", async () => {
  let asked: URL | undefined;
  const f = routes({
    "GET /activities": (url: URL) => {
      asked = url;
      return Response.json({ data: [
        { id: "act_1", source: { id, name: "Front door" }, kind: "presence", label: "person", zone: "kitchen", watch_id: null, started_at: iso(at(8)), ended_at: iso(at(9, 25)), ongoing: false, duration_s: 5100, peak_count: 2, confidence: 0.9, verified: null, summary: null, checked: false },
        { id: "act_2", source: { id, name: "Front door" }, kind: "watch", label: "wat_1", zone: null, watch_id: "wat_1", started_at: iso(at(14, 48)), ended_at: null, ongoing: true, duration_s: 720, peak_count: 1, confidence: 0.8, verified: true, summary: "Eating lunch", checked: false },
        { id: "act_3", source: { id, name: "Front door" }, kind: "sound", label: "crying", zone: null, watch_id: null, started_at: iso(at(10)), ended_at: iso(at(10) + 45_000), ongoing: false, duration_s: 45, peak_count: 1, confidence: 0.7, verified: null, summary: null, checked: true },
      ] });
    },
    "GET /watches": { data: [{ id: "wat_1", instruction: "Eating at the table", sources: [id], mode: "track", compiled: { trigger: { type: "objects", label: "person", on: "present" }, cooldown_s: 0, active_hours: null }, estimate: { vlm_calls_per_day: "1-5" }, status: "active", warnings: [], created_at: iso(at(1)) }], next_cursor: null },
  });
  const { container } = renderWithApp(<CameraPage id={id} />, appData({ sources: [cam], fetch: f }));
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Activity" }));
  expect(await screen.findByText("Person in kitchen")).toBeInTheDocument();
  expect(screen.getByText("1 h 25 min")).toBeInTheDocument();
  expect(screen.getByText("Up to 2 at once")).toBeInTheDocument();
  expect(screen.getByText("Crying")).toBeInTheDocument();
  expect(screen.getByText("45 s")).toBeInTheDocument();
  expect(screen.getByText("Checked later")).toBeInTheDocument();
  // The watch's instruction, not its summary (it also shows in the Watches card).
  const panel = screen.getByRole("tabpanel");
  expect(await within(panel).findByText("Eating at the table")).toBeInTheDocument();
  expect(screen.getByText("now")).toBeInTheDocument();
  expect(screen.getByText("12 min so far")).toBeInTheDocument();
  // Newest first: the ongoing watch, then the sound, then the person.
  expect([...container.querySelectorAll(".cam-act .cam-event-text > span:first-child")].map((e) => e.textContent)).toEqual(["Eating at the table", "Crying", "Person in kitchen"]);
  expect(container.querySelectorAll(".cam-act-seg")).toHaveLength(1);
  expect(asked?.searchParams.get("source")).toBe(id);
  expect(asked?.searchParams.get("from")).toBe(iso(at(0)));
  expect(asked?.searchParams.get("limit")).toBe("200");
});

it("has no Activity tab for sensors", () => {
  const sensor = source({ id: "src_sensor", name: "Fridge", type: "sensor", senses: ["temperature"] } as never);
  renderWithApp(<CameraPage id="src_sensor" />, appData({ sources: [sensor], fetch: routes() }));
  expect(screen.getByRole("tab", { name: "Events" })).toBeInTheDocument();
  expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
});

it("words durations plainly", () => {
  expect(durationText(45)).toBe("45 s");
  expect(durationText(720)).toBe("12 min");
  expect(durationText(5100)).toBe("1 h 25 min");
  expect(durationText(7200)).toBe("2 h");
  expect(durationText(3590)).toBe("1 h");
});

it("saves the site from the Settings tab, and clears it when emptied", async () => {
  const site = { ...cam, site: "Home" } as typeof cam;
  const putSource = vi.fn();
  const bodies: unknown[] = [];
  const f = routes();
  const wrapped: typeof fetch = async (input, init) => {
    if (input instanceof Request && input.method === "PATCH") {
      const body = JSON.parse(await input.text());
      bodies.push(body);
      return Response.json({ ...site, ...body });
    }
    return f(input, init);
  };
  renderWithApp(<CameraPage id={id} />, appData({ sources: [site], fetch: wrapped, putSource }));
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Settings" }));
  const field = screen.getByLabelText("Site");
  expect(field).toHaveValue("Home");
  expect(field).toHaveAttribute("placeholder", "Home, High St shop");
  await user.clear(field);
  await user.type(field, "High St shop{Enter}");
  await waitFor(() => expect(bodies).toEqual([{ site: "High St shop" }]));
  expect(await screen.findByText("Site saved.")).toBeInTheDocument();
  await user.clear(field);
  await user.type(field, "{Enter}");
  await waitFor(() => expect(bodies).toEqual([{ site: "High St shop" }, { site: null }]));
  expect(putSource).toHaveBeenLastCalledWith(expect.objectContaining({ site: null }));
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
