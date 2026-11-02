// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { navigate } from "../router";
import { appData, fakeFetch, renderWithApp } from "../test/render";
import { BoxPage, LinkPage, boxStatus } from "./Boxes";

afterEach(() => navigate("/", { replace: true }));

const BOX = { id: "brg_1", name: "Mum's box", version: "0.3.0", created_at: "2026-11-02T08:00:00Z", last_seen_at: new Date().toISOString(), online: true,
  home_assistant: { connected: true, entities: 3, sending: 1 } };
const ENTITY = (entity_id: string, name: string, area: string | null, sense: string, kind: string, chosen = false) =>
  ({ entity_id, name, area, device_class: null, sense, kind, chosen, source_id: chosen ? "src_k" : null, listed: true });

it("words a box's state", () => {
  expect(boxStatus(BOX as never)).toEqual({ tone: "live", text: "1 of 3 sensors sent" });
  expect(boxStatus({ ...BOX, home_assistant: { connected: false, entities: 3, sending: 1 } } as never).text).toBe("Can't reach Home Assistant");
  expect(boxStatus({ ...BOX, online: false, last_seen_at: null } as never)).toEqual({ tone: "off", text: "Not connected yet" });
});

it("connects the box that shows a code, from the link it gives", async () => {
  navigate("/link?code=BCDF-GHJK", { replace: true });
  let paired: unknown;
  const f = fakeFetch({
    "GET /bridges/pair": (url: URL) => Response.json(url.searchParams.get("code") === "BCDF-GHJK" ? { code: "BCDF-GHJK", name: "Home Assistant", expires_at: "2026-11-02T09:00:00Z" } : {}),
    "POST /bridges/pair": async (_u: URL, init?: RequestInit) => { paired = JSON.parse(String(init?.body)); return Response.json({ id: "brg_9", name: "Mum's box" }, { status: 201 }); },
  });
  renderWithApp(<LinkPage />, appData({ fetch: f }));
  expect(await screen.findByText("Home Assistant")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mum's box" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(location.pathname).toBe("/boxes/brg_9"));
  expect(paired).toEqual({ code: "BCDF-GHJK", name: "Mum's box" });
});

it("says when a code isn't waiting", async () => {
  navigate("/link", { replace: true });
  const f = fakeFetch({ "GET /bridges/pair": () => Response.json({ error: { code: "not_found", message: "No box is waiting with this code." } }, { status: 404 }) });
  renderWithApp(<LinkPage />, appData({ fetch: f }));
  fireEvent.change(screen.getByLabelText("Code"), { target: { value: "bbbb bbbb" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText("No box is waiting with this code.")).toBeInTheDocument();
});

it("lists a box's sensors by room and chooses them", async () => {
  let entities = [
    ENTITY("binary_sensor.fridge", "Fridge door", "Kitchen", "contact", "state", true),
    ENTITY("sensor.kitchen_temp", "Kitchen temperature", "Kitchen", "temperature", "number"),
    ENTITY("event.doorbell", "Doorbell", null, "doorbell", "event"),
  ];
  const changes: unknown[] = [];
  const f = fakeFetch({
    "GET /bridges": { data: [BOX] },
    "GET /bridges/brg_1/entities": () => Response.json({ data: entities }),
    "PATCH /bridges/brg_1/entities": async (_u: URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      changes.push(body);
      entities = entities.map((e) => (body.choose?.includes(e.entity_id) ? { ...e, chosen: true } : body.drop?.includes(e.entity_id) ? { ...e, chosen: false } : e));
      return Response.json({ data: entities });
    },
  });
  renderWithApp(<BoxPage id="brg_1" />, appData({ fetch: f }));
  expect(await screen.findByRole("heading", { name: "Mum's box" })).toBeInTheDocument();
  expect(screen.getByText("1 of 3 sensors sent")).toBeInTheDocument();
  const kitchen = (await screen.findByRole("heading", { name: "Kitchen" })).closest("section")!;
  expect(within(kitchen).getAllByRole("switch").map((s) => s.getAttribute("aria-checked"))).toEqual(["true", "false"]); // the door first, then the number
  expect(screen.getByRole("heading", { name: "No room" })).toBeInTheDocument();
  fireEvent.click(within(kitchen).getByRole("button", { name: "Choose all" }));
  await waitFor(() => expect(changes).toEqual([{ choose: ["sensor.kitchen_temp"] }]));
  await waitFor(() => expect(within(kitchen).getAllByRole("switch").every((s) => s.getAttribute("aria-checked") === "true")).toBe(true));
  fireEvent.click(within(kitchen).getAllByRole("switch")[0]!);
  await waitFor(() => expect(changes.at(-1)).toEqual({ drop: ["binary_sensor.fridge"] }));
});

it("adds an IP camera through the box", async () => {
  let created: unknown;
  const base = fakeFetch({ "GET /bridges": { data: [BOX] }, "GET /bridges/brg_1/entities": { data: [] } });
  // The SDK sends a Request, so its body is read here.
  const f: typeof fetch = async (input, init) => {
    if (input instanceof Request && input.method === "POST" && input.url.endsWith("/sources")) {
      created = JSON.parse(await input.text());
      return Response.json({ id: "src_cam", name: "Porch", type: "rtsp", senses: ["video"], status: "pending" }, { status: 201 });
    }
    return base(input, init);
  };
  renderWithApp(<BoxPage id="brg_1" />, appData({ fetch: f }));
  fireEvent.change(await screen.findByLabelText("Camera name"), { target: { value: "Porch" } });
  fireEvent.change(screen.getByLabelText(/RTSP address/), { target: { value: "http://nope" } });
  fireEvent.click(screen.getByRole("button", { name: "Add camera" }));
  expect(await screen.findByText(/starts with rtsp:\/\//)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/RTSP address/), { target: { value: "rtsp://u:p@192.168.1.40:554/stream1" } });
  fireEvent.click(screen.getByRole("button", { name: "Add camera" }));
  await waitFor(() => expect(created).toEqual({ name: "Porch", type: "rtsp", rtsp_url: "rtsp://u:p@192.168.1.40:554/stream1", bridge_id: "brg_1" }));
});
