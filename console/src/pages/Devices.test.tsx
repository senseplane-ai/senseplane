// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Device, DeviceCommand } from "../api/extra";
import type { Me } from "../api/extra";
import { appData, fakeFetch, renderWithApp } from "../test/render";
import { DevicesPage } from "./Devices";
import { ConfirmationsBanner } from "./devices/Confirmations";
import { stateText, timeLeft } from "./devices/control";

const me = (role: Me["role"]): Me => ({ user: { id: "usr_1", email: "alex@example.com", name: "Alex" }, role, account: { id: "acc_1", name: "Home" } });

const device = (over: Partial<Device>): Device => ({
  id: "dev_1", entity_id: "light.hall", name: "Hall light", room: "Hall", bridge_id: "brg_1", source_id: "src_1",
  type: "light", tier: "switch", controllable: true, actions: ["turn_on", "turn_off", "set_brightness"],
  state: { on: false }, online: true, can_control: true, warning: "", ...over,
});

const LIGHT = device({});
const LOCK = device({ id: "dev_2", entity_id: "lock.front", name: "Front door", room: "Hall", type: "lock", tier: "secure", actions: ["lock", "unlock"], state: { locked: true } });
const BLIND = device({ id: "dev_3", entity_id: "cover.blind", name: "Bedroom blind", room: "Bedroom", type: "cover", actions: ["open", "close", "set_position"], state: { open: true, position: 40 } });
const HEAT = device({ id: "dev_4", entity_id: "climate.hall", name: "Hallway heating", room: null, type: "climate", actions: ["set_temperature", "set_mode"], state: { mode: "heat", target_temperature: 21 } });
const PLUG = device({
  id: "dev_5", entity_id: "switch.kettle", name: "Kitchen plug", room: "Kitchen", type: "switch", controllable: false, can_control: false, actions: ["turn_on", "turn_off"],
  warning: "Only make a plug controllable if nothing dangerous is plugged into it: no heaters, irons or machinery.",
});

const cmd = (over: Partial<DeviceCommand>): DeviceCommand => ({
  id: "dcm_1", device_id: "dev_1", device_name: "Hall light", entity_id: "light.hall", action: "turn_on", value: null,
  status: "done", message: "", state: null, requested_by: { kind: "user", id: "usr_1", name: "Alex" }, via: "console",
  expires_at: null, decided_by: null, created_at: "2026-11-03T08:00:00Z", finished_at: null, ...over,
});

const card = (name: string) => within(screen.getByRole("article", { name }));
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body));

describe("words", () => {
  it("reads each kind of device", () => {
    expect(stateText("light", { on: true, brightness: 80 })).toBe("On · 80%");
    expect(stateText("switch", { on: false })).toBe("Off");
    expect(stateText("cover", { open: true, position: 40 })).toBe("Open 40%");
    expect(stateText("garage_door", { open: false, moving: "opening" })).toBe("Opening");
    expect(stateText("gate", { open: false })).toBe("Closed");
    expect(stateText("lock", { locked: false })).toBe("Unlocked");
    expect(stateText("alarm", { alarm: "armed_away" })).toBe("Armed (away)");
    expect(stateText("climate", { mode: "heat", target_temperature: 21.5 })).toBe("Heat · set to 21.5 °C");
    expect(stateText("light", null)).toBe("No reading yet");
    expect(stateText("light", { available: false, on: true })).toBe("Unavailable");
    expect(timeLeft("2026-11-03T08:02:00Z", Date.parse("2026-11-03T08:00:18Z"))).toBe("1:42 left");
  });
});

describe("DevicesPage", () => {
  it("lists devices by room with their state, and a switch sends the command and shows the answer", async () => {
    const sent: unknown[] = [];
    const f = fakeFetch({
      "GET /devices": { data: [LIGHT, LOCK, BLIND, HEAT], next_cursor: null },
      "POST /devices/dev_1/commands": (_u: URL, init?: RequestInit) => {
        sent.push(bodyOf(init));
        return Response.json(cmd({ status: "done", message: "Hall light is on.", state: { on: true, brightness: 80 } }));
      },
    });
    renderWithApp(<DevicesPage />, appData({ fetch: f, me: me("member") }));
    expect(await screen.findByRole("heading", { name: "Hall" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bedroom" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No room" })).toBeInTheDocument();
    expect(card("Front door").getByText("Locked")).toBeInTheDocument();
    expect(card("Bedroom blind").getByText("Open 40%")).toBeInTheDocument();
    expect(card("Hallway heating").getByText("Heat · set to 21 °C")).toBeInTheDocument();
    expect(card("Hall light").getByText("Off")).toBeInTheDocument();
    expect(card("Hall light").getByText("Online")).toBeInTheDocument();
    // Members don't see the controllable switch.
    expect(screen.queryByRole("switch", { name: "Controllable" })).toBeNull();

    fireEvent.click(card("Hall light").getByRole("switch", { name: "Power" }));
    expect(await card("Hall light").findByText("Hall light is on.")).toBeInTheDocument();
    expect(sent).toEqual([{ action: "turn_on" }]);
    expect(card("Hall light").getByText("On · 80%")).toBeInTheDocument();
    expect(card("Hall light").getByRole("switch", { name: "Power" })).toHaveAttribute("aria-checked", "true");
    expect(card("Hall light").getByRole("button", { name: "75%" })).toHaveAttribute("aria-pressed", "false");
    expect(card("Hall light").getByRole("button", { name: "75%" })).toBeEnabled();
  });

  it("sends a brightness step and a thermostat setting within 10–28 °C", async () => {
    const sent: unknown[] = [];
    const f = fakeFetch({
      "GET /devices": { data: [LIGHT, { ...HEAT, state: { mode: "heat", target_temperature: 28 } }], next_cursor: null },
      "POST /devices/dev_1/commands": (_u: URL, init?: RequestInit) => { sent.push(bodyOf(init)); return Response.json(cmd({ message: "Hall light is at 50%." })); },
      "POST /devices/dev_4/commands": (_u: URL, init?: RequestInit) => { sent.push(bodyOf(init)); return Response.json(cmd({ device_id: "dev_4", device_name: "Hallway heating", message: "Hallway heating is set to 27.5 °C." })); },
    });
    renderWithApp(<DevicesPage />, appData({ fetch: f, me: me("member") }));
    await screen.findByRole("article", { name: "Hall light" });
    fireEvent.click(card("Hall light").getByRole("button", { name: "50%" }));
    await card("Hall light").findByText("Hall light is at 50%.");
    expect(card("Hallway heating").getByRole("button", { name: "Raise to 28 °C" })).toBeDisabled();
    fireEvent.click(card("Hallway heating").getByRole("button", { name: "Lower to 27.5 °C" }));
    await card("Hallway heating").findByText("Hallway heating is set to 27.5 °C.");
    expect(sent).toEqual([{ action: "set_brightness", value: 50 }, { action: "set_temperature", value: 27.5 }]);
  });

  it("shows an unchanged answer as not done", async () => {
    const f = fakeFetch({
      "GET /devices": { data: [LIGHT], next_cursor: null },
      "POST /devices/dev_1/commands": () => Response.json(cmd({ status: "unchanged", message: "Sent, but Hall light still reads off.", state: { on: false } })),
    });
    renderWithApp(<DevicesPage />, appData({ fetch: f, me: me("member") }));
    fireEvent.click(await screen.findByRole("switch", { name: "Power" }));
    const answer = await card("Hall light").findByText("Sent, but Hall light still reads off.");
    expect(answer).toHaveClass("device-answer-warn");
    expect(card("Hall light").getByText("Off")).toBeInTheDocument();
    expect(card("Hall light").getByRole("switch", { name: "Power" })).toHaveAttribute("aria-checked", "false");
  });

  it("says plainly when the box is offline or the device failed", async () => {
    const f = fakeFetch({
      "GET /devices": { data: [LIGHT], next_cursor: null },
      "POST /devices/dev_1/commands": () => Response.json({ error: { code: "device_offline", message: "Hall light's box didn't answer.", details: {
        command: cmd({ status: "offline", message: "Hall light's box didn't take it within 10 seconds, so it won't run later." }) } } }, { status: 503 }),
    });
    renderWithApp(<DevicesPage />, appData({ fetch: f, me: me("member") }));
    fireEvent.click(await screen.findByRole("switch", { name: "Power" }));
    expect(await card("Hall light").findByText("Hall light's box didn't take it within 10 seconds, so it won't run later.")).toHaveClass("device-answer-error");
  });

  it("asks a person to confirm a lock before sending, then sends with confirm", async () => {
    const sent: unknown[] = [];
    const f = fakeFetch({
      "GET /devices": { data: [LOCK], next_cursor: null },
      "POST /devices/dev_2/commands": (_u: URL, init?: RequestInit) => {
        sent.push(bodyOf(init));
        return Response.json(cmd({ device_id: "dev_2", device_name: "Front door", action: "unlock", message: "Front door is unlocked.", state: { locked: false } }));
      },
    });
    renderWithApp(<DevicesPage />, appData({ fetch: f, me: me("member") }));
    await screen.findByRole("article", { name: "Front door" });
    expect(card("Front door").getByText("Confirm each change")).toBeInTheDocument();
    fireEvent.click(card("Front door").getByRole("button", { name: "Unlock" }));
    const dialog = within(screen.getByRole("dialog", { name: "Unlock Front door?" }));
    expect(sent).toEqual([]);
    fireEvent.click(dialog.getByRole("button", { name: "Unlock" }));
    expect(await card("Front door").findByText("Front door is unlocked.")).toBeInTheDocument();
    expect(sent).toEqual([{ action: "unlock", confirm: true }]);
    expect(card("Front door").getByText("Unlocked")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the confirm dialog when the server answers confirmation_required", async () => {
    const sent: { action: string; confirm?: boolean }[] = [];
    const GATE = device({ id: "dev_6", name: "Drive gate", type: "gate", tier: "switch", actions: ["open", "close"], state: { open: false } });
    const f = fakeFetch({
      "GET /devices": { data: [GATE], next_cursor: null },
      "POST /devices/dev_6/commands": (_u: URL, init?: RequestInit) => {
        const b = bodyOf(init);
        sent.push(b);
        if (!b.confirm) return Response.json({ error: { code: "confirmation_required", message: "Confirm to open Drive gate." } }, { status: 409 });
        return Response.json(cmd({ device_id: "dev_6", device_name: "Drive gate", action: "open", status: "in_progress", message: "Drive gate is opening.", state: { open: false, moving: "opening" } }));
      },
    });
    renderWithApp(<DevicesPage />, appData({ fetch: f, me: me("member") }));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Open Drive gate?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Open" }));
    expect(await card("Drive gate").findByText("Drive gate is opening.")).toHaveClass("device-answer-wait");
    expect(sent).toEqual([{ action: "open" }, { action: "open", confirm: true }]);
    expect(card("Drive gate").getByText("Opening")).toBeInTheDocument();
  });

  it("lets an admin make a plug controllable after showing its warning", async () => {
    let patched: unknown;
    const f = fakeFetch({
      "GET /devices": { data: [PLUG], next_cursor: null },
      "PATCH /devices/dev_5": (_u: URL, init?: RequestInit) => { patched = bodyOf(init); return Response.json({ ...PLUG, controllable: true, can_control: true }); },
    });
    renderWithApp(<DevicesPage />, appData({ fetch: f, me: me("admin") }));
    const plug = await screen.findByRole("article", { name: "Kitchen plug" });
    expect(within(plug).queryByRole("switch", { name: "Power" })).toBeNull();
    expect(within(plug).getByText("Turn on Controllable to switch it from here.")).toBeInTheDocument();
    fireEvent.click(within(plug).getByRole("switch", { name: "Controllable" }));
    const dialog = within(screen.getByRole("dialog", { name: "Make Kitchen plug controllable?" }));
    expect(dialog.getByText(PLUG.warning)).toBeInTheDocument();
    expect(patched).toBeUndefined();
    fireEvent.click(dialog.getByRole("button", { name: "Make controllable" }));
    await waitFor(() => expect(patched).toEqual({ controllable: true }));
    await waitFor(() => expect(within(plug).getByRole("switch", { name: "Controllable" })).toHaveAttribute("aria-checked", "true"));
    expect(within(plug).getByRole("switch", { name: "Power" })).toBeEnabled();
  });

  it("keeps controls off when the person can't control the device", async () => {
    const f = fakeFetch({ "GET /devices": { data: [{ ...LIGHT, can_control: false }, PLUG], next_cursor: null } });
    renderWithApp(<DevicesPage />, appData({ fetch: f, me: me("viewer") }));
    await screen.findByRole("article", { name: "Hall light" });
    expect(card("Hall light").getByRole("switch", { name: "Power" })).toBeDisabled();
    expect(card("Hall light").getByText("Your role can't switch devices.")).toBeInTheDocument();
    expect(card("Kitchen plug").getByText("An admin hasn't made this device controllable.")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Controllable" })).toBeNull();
  });
});

describe("ConfirmationsBanner", () => {
  const soon = () => new Date(Date.now() + 100_000).toISOString();

  it("shows who asked for what with the time left, and approves or denies", async () => {
    let waiting = [
      cmd({ id: "dcm_1", device_id: "dev_2", device_name: "Front door", action: "unlock", status: "awaiting_confirmation", via: "agent",
        requested_by: { kind: "agent", id: "agt_1", name: "Claude Code" }, expires_at: soon() }),
      cmd({ id: "dcm_2", device_id: "dev_7", device_name: "Garage door", action: "open", status: "awaiting_confirmation", via: "telegram",
        requested_by: { kind: "user", id: "usr_2", name: "Sam" }, expires_at: soon() }),
    ];
    const decided: { id: string; body: unknown }[] = [];
    const decide = (id: string, done: Partial<DeviceCommand>) => (_u: URL, init?: RequestInit) => {
      decided.push({ id, body: bodyOf(init) });
      waiting = waiting.filter((c) => c.id !== id);
      return Response.json({ ...waiting[0], id, ...done });
    };
    const f = fakeFetch({
      "GET /confirmations": () => Response.json({ data: waiting }),
      "POST /confirmations/dcm_1": decide("dcm_1", { status: "done", device_name: "Front door", message: "Front door is unlocked." }),
      "POST /confirmations/dcm_2": decide("dcm_2", { status: "denied", device_name: "Garage door", message: "" }),
    });
    renderWithApp(<ConfirmationsBanner pollMs={60_000} />, appData({ fetch: f, me: me("member") }));
    expect(await screen.findByRole("heading", { name: "2 requests waiting for you to confirm" })).toBeInTheDocument();
    const first = within(screen.getByRole("listitem", { name: "Claude Code asked to unlock Front door" }));
    expect(first.getByText(/via an agent · 1:\d\d left/)).toBeInTheDocument();
    const second = within(screen.getByRole("listitem", { name: "Sam asked to open Garage door" }));
    expect(second.getByText(/via Telegram/)).toBeInTheDocument();

    fireEvent.click(first.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Front door is unlocked.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Waiting for you to confirm" })).toBeInTheDocument();
    fireEvent.click(second.getByRole("button", { name: "Deny" }));
    expect(await screen.findByText("Denied. Garage door stays as it is.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: /waiting for you to confirm/ })).toBeNull());
    expect(decided).toEqual([{ id: "dcm_1", body: { approve: true } }, { id: "dcm_2", body: { approve: false } }]);
  });

  it("stays hidden when nothing waits, for viewers, and on servers without confirmations", async () => {
    let calls = 0;
    const f = fakeFetch({ "GET /confirmations": () => { calls++; return Response.json({ data: [] }); } });
    const { unmount } = renderWithApp(<ConfirmationsBanner />, appData({ fetch: f, me: me("owner") }));
    await waitFor(() => expect(calls).toBe(1));
    expect(screen.queryByRole("heading", { name: /confirm/ })).toBeNull();
    unmount();
    calls = 0;
    renderWithApp(<ConfirmationsBanner />, appData({ fetch: f, me: me("viewer") }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
  });
});
