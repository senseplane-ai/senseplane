// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { navigate } from "../router";
import { appData, fakeFetch, renderWithApp } from "../test/render";
import { BoxPage, LinkPage, boxStatus, foundTitle } from "./Boxes";

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

it("adds a Matter device with a code shared from its app, on a box that runs Matter", async () => {
  let status = "pending";
  let body: unknown;
  const f = fakeFetch({
    "GET /bridges": { data: [{ ...BOX, home_assistant: null, matter: { connected: true, nodes: 1 } }] },
    "GET /bridges/brg_1/entities": { data: [] },
    "POST /bridges/brg_1/matter": async (_u: URL, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return Response.json({ id: "bcm_1", kind: "matter_commission", status, result: null, error: null, created_at: "2026-11-02T08:00:00Z", finished_at: null }, { status: 202 }); },
    "GET /bridges/brg_1/commands/bcm_1": () => Response.json({ id: "bcm_1", kind: "matter_commission", status, result: status === "done" ? { node_id: 2 } : null, error: null, created_at: "2026-11-02T08:00:00Z", finished_at: null }),
  });
  renderWithApp(<BoxPage id="brg_1" />, appData({ fetch: f }));
  expect(await screen.findByText("1 Matter device")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/Pairing code/), { target: { value: "3497-011-2332" } });
  fireEvent.click(screen.getByRole("button", { name: "Add device" }));
  expect(await screen.findByText("Waiting for the box…")).toBeInTheDocument();
  expect(body).toEqual({ code: "3497-011-2332" });
  status = "done";
  expect(await screen.findByText("Added. Choose its sensors above.", {}, { timeout: 4000 })).toBeInTheDocument();
});

it("doesn't offer Matter on a box without it", async () => {
  const f = fakeFetch({ "GET /bridges": { data: [BOX] }, "GET /bridges/brg_1/entities": { data: [] } });
  renderWithApp(<BoxPage id="brg_1" />, appData({ fetch: f }));
  expect(await screen.findByRole("heading", { name: "Mum's box" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Matter devices" })).toBeNull();
});

const FOUND = [
  { id: "urn:uuid:cam-1", address: "192.168.1.40", manufacturer: "tp-link", model: "Tapo C200", name: "TP-IPC", onvif: true,
    home_assistant: { entity_id: "camera.front_door", name: "Front door", area: "Kitchen" }, source_id: null, seen_at: "2026-11-02T08:00:00Z" },
  { id: "urn:uuid:cam-2", address: "192.168.1.41", manufacturer: "Reolink", model: "RLC-510A", name: null, onvif: true, home_assistant: null, source_id: "src_porch", seen_at: "2026-11-02T08:00:00Z" },
  { id: "camera.nest_doorbell", address: null, manufacturer: "Google Nest", model: null, name: null, onvif: false,
    home_assistant: { entity_id: "camera.nest_doorbell", name: "Doorbell", area: null }, source_id: null, seen_at: "2026-11-02T08:00:00Z" },
];

it("names a camera it found after Home Assistant's, else its model", () => {
  expect(foundTitle(FOUND[0] as never)).toEqual({ title: "Front door (Kitchen)", detail: "Tapo C200 at 192.168.1.40" });
  expect(foundTitle(FOUND[1] as never)).toEqual({ title: "RLC-510A", detail: "Reolink at 192.168.1.41" });
  expect(foundTitle(FOUND[2] as never)).toEqual({ title: "Doorbell", detail: "Google Nest" });
});

it("adds a camera found on the network with its username and password, and shows how it goes", async () => {
  let status = "pending";
  let body: unknown;
  let found: unknown[] = FOUND;
  const cmd = () => ({ id: "bcm_7", kind: "onvif_add_camera", status, result: status === "done" ? { source_id: "src_front" } : null, error: null, created_at: "2026-11-02T08:00:00Z", finished_at: null });
  const f = fakeFetch({
    "GET /bridges": { data: [{ ...BOX, cameras_found: 3 }] },
    "GET /bridges/brg_1/entities": { data: [] },
    "GET /bridges/brg_1/cameras-found": () => Response.json({ data: found }),
    "POST /bridges/brg_1/onvif": async (_u: URL, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return Response.json(cmd(), { status: 202 }); },
    "GET /bridges/brg_1/commands/bcm_7": () => Response.json(cmd()),
  });
  renderWithApp(<BoxPage id="brg_1" />, appData({ fetch: f }));
  const card = (await screen.findByRole("heading", { name: "Found on your network" })).closest("section")!;
  expect(await within(card).findByText("Front door (Kitchen)")).toBeInTheDocument();
  expect(within(card).getByText("· Tapo C200 at 192.168.1.40")).toBeInTheDocument();
  expect(within(card).getByRole("link", { name: "Added" })).toHaveAttribute("href", "/cameras/src_porch");
  expect(within(card).getByText("Add it with its RTSP address below")).toBeInTheDocument(); // the cloud camera
  expect(within(card).getAllByRole("button", { name: "Add" })).toHaveLength(1);

  fireEvent.click(within(card).getByRole("button", { name: "Add" }));
  fireEvent.change(within(card).getByLabelText("Username"), { target: { value: "admin" } });
  fireEvent.change(within(card).getByLabelText("Password"), { target: { value: "s3cret" } });
  expect(within(card).getByLabelText("Password")).toHaveAttribute("type", "password");
  fireEvent.click(within(card).getByRole("button", { name: "Add camera" }));
  expect(await within(card).findByText("Waiting for the box…")).toBeInTheDocument();
  expect(body).toEqual({ camera: "urn:uuid:cam-1", username: "admin", password: "s3cret" });
  expect(within(card).getByLabelText("Password")).toHaveValue(""); // not kept on the page
  status = "done";
  found = [{ ...FOUND[0]!, source_id: "src_front" }, FOUND[1]!, FOUND[2]!];
  expect(await within(card).findByText("Added. It shows under Cameras within a minute.", {}, { timeout: 4000 })).toBeInTheDocument();
  await waitFor(() => expect(within(card).getAllByRole("link", { name: "Added" })).toHaveLength(2));
});

it("says why a camera couldn't be added, and looks again when asked", async () => {
  let searched = false;
  const f = fakeFetch({
    "GET /bridges": { data: [{ ...BOX, cameras_found: 1 }] },
    "GET /bridges/brg_1/entities": { data: [] },
    "GET /bridges/brg_1/cameras-found": { data: [FOUND[0]] },
    "POST /bridges/brg_1/onvif": () => Response.json({ id: "bcm_8", kind: "onvif_add_camera", status: "failed", result: null, error: "the camera refused the username or password", created_at: "2026-11-02T08:00:00Z", finished_at: null }, { status: 202 }),
    "POST /bridges/brg_1/cameras-found/search": () => { searched = true; return Response.json({ id: "bcm_9", kind: "onvif_search", status: "pending", result: null, error: null, created_at: "2026-11-02T08:00:00Z", finished_at: null }, { status: 202 }); },
  });
  renderWithApp(<BoxPage id="brg_1" />, appData({ fetch: f }));
  const card = (await screen.findByRole("heading", { name: "Found on your network" })).closest("section")!;
  fireEvent.click(await within(card).findByRole("button", { name: "Add" }));
  fireEvent.change(within(card).getByLabelText("Username"), { target: { value: "admin" } });
  fireEvent.click(within(card).getByRole("button", { name: "Add camera" }));
  expect(await within(card).findByText("Couldn't add it: the camera refused the username or password")).toBeInTheDocument();
  fireEvent.click(within(card).getByRole("button", { name: "Look again" }));
  expect(await within(card).findByRole("button", { name: "Looking…" })).toBeDisabled();
  expect(searched).toBe(true);
});

it("doesn't show cameras found on a box that doesn't look for them", async () => {
  const f = fakeFetch({ "GET /bridges": { data: [{ ...BOX, cameras_found: null }] }, "GET /bridges/brg_1/entities": { data: [] } });
  renderWithApp(<BoxPage id="brg_1" />, appData({ fetch: f }));
  expect(await screen.findByRole("heading", { name: "Mum's box" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Found on your network" })).toBeNull();
});
