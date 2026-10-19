// @vitest-environment jsdom
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WatchesPage, activeHours, activeLabel, describeTrigger } from "./WatchesPage";
import { SRC, agent, event, fail, me, page, reply, setup, sources, watch, webhook } from "./test-utils";

const hook = webhook(1, { url: "https://ops.example.com/hooks" });
const claude = agent(1, "Claude");

function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /me": me("owner"),
    "GET /sources": sources(),
    "GET /account": { id: "acc_1", name: "Northwind", time_zone: "Europe/Berlin", retention_days: 7, retention_max_days: null, retention_mode: "days", created_at: "2026-01-01T00:00:00Z" },
    "GET /watches": page([
      watch(1, { instruction: "Tell me when someone is at the front door", notify: [{ type: "webhook", id: hook.id }] }),
      watch(2, { instruction: "Warn me if the parking lot is full", status: "paused", sources: [SRC.front, SRC.dock, SRC.lobby], notify: [], active_hours: { days: ["mon", "tue", "wed", "thu", "fri"], from: "07:00", to: "10:00" } }),
    ]),
    "GET /webhooks": page([hook]),
    "GET /agents": page([claude]),
    "GET /events": page([event(1, { type: "watch.triggered", watch_id: watch(1).id, occurred_at: new Date().toISOString() })]),
    "POST /watches": (r: { body: { instruction: string; sources: string[] } }) => watch(9, { ...r.body, compiled: { trigger: { type: "objects", label: "person", on: "present", min_duration_s: 300 }, verify: { prompt: "Is the dock door open?", min_confidence: 0.6 }, cooldown_s: 600, active_hours: null } }),
    "POST /watches/test": { matches: [{ source_id: SRC.dock, source_name: "Loading dock", at: new Date().toISOString(), summary: "Door open", snapshot_url: "https://media.test/x.jpg" }], checks_used: 3 },
    "PATCH /watches/:id": (r: { params: { id: string }; body: object }) => ({ ...watch(1), id: r.params.id, ...r.body }),
    "GET /watch-packs": { data: [
      { id: "eldercare", name: "Eldercare", description: "Meals, sleep and getting up at night.", watches: [
        { key: "meals", instruction: "Eating at the table", mode: "track" },
        { key: "night", instruction: "Up at night", mode: "alert", hours: { from: "23:00", to: "06:00" } },
      ] },
      { id: "shop", name: "Shop", description: "Opening, closing and queues.", watches: [{ key: "queue", instruction: "A queue at the till", mode: "alert" }] },
    ] },
    "POST /watch-packs/:id/apply": (r: { params: { id: string }; body: { items?: string[] } }) => reply(201, { pack: r.params.id, watches: (r.body.items ?? ["meals", "night"]).map((k, i) => watch(20 + i, { instruction: k })) }),
    ...over,
  };
}

describe("WatchesPage", () => {
  it("lists running watches with chips, last fired and on/off", async () => {
    const { props } = setup(routes());
    render(<WatchesPage {...props} />);
    const row = (await screen.findByText("Tell me when someone is at the front door")).closest(".adm-watch") as HTMLElement;
    expect(within(row).getByText("person enters → AI check")).toBeTruthy();
    expect(within(row).getByText("→ ops.example.com")).toBeTruthy();
    expect(await within(row).findByText(/^Fired \d\d:\d\d$/)).toBeTruthy();
    expect(within(row).getByText("Once today")).toBeTruthy();
    const paused = screen.getByText("Warn me if the parking lot is full").closest(".adm-watch") as HTMLElement;
    expect(within(paused).getByText("All cameras")).toBeTruthy();
    expect(within(paused).getByText("Weekdays 07:00–10:00")).toBeTruthy();
    expect(within(paused).getByText("→ Subscribed webhooks")).toBeTruthy(); // no destinations: every subscribed webhook
    expect(within(paused).getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("multi-selects cameras and destinations and starts a watch with notify and active hours", async () => {
    const { props, api } = setup(routes());
    render(<WatchesPage {...props} />);
    fireEvent.change(screen.getByLabelText("What should Senseplane watch for?"), { target: { value: "Tell me if the loading dock door stays open after 6 pm" } });
    const cams = screen.getByRole("group", { name: /Watch on/ });
    fireEvent.click(await within(cams).findByRole("button", { name: "All cameras" }));
    expect(within(cams).getAllByRole("button").every((b) => b.getAttribute("aria-pressed") === "true")).toBe(true);
    fireEvent.click(within(cams).getByRole("button", { name: "Reception" }));
    expect(within(cams).getByRole("button", { name: "All cameras" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(cams).getByText("2 cameras")).toBeTruthy();

    const dests = screen.getByRole("group", { name: /Send to/ });
    fireEvent.click(await within(dests).findByRole("button", { name: /ops\.example\.com/ }));
    fireEvent.click(within(dests).getByRole("button", { name: /Claude/ }));
    expect(screen.getByText("Then tell ops.example.com and Claude")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Active" }), { target: { value: "nights" } });

    fireEvent.click(screen.getByRole("button", { name: "Start watching" }));
    await screen.findByText("Ask the AI: “Is the dock door open?”");
    const body = api.called("POST", "/watches")[0]!.body;
    expect(body.sources).toEqual([SRC.front, SRC.dock]);
    expect(body.notify).toEqual([{ type: "webhook", id: hook.id }, { type: "agent", id: claude.id }]);
    expect(body.active_hours).toEqual({ days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], from: "18:00", to: "06:00", time_zone: "Europe/Berlin" });
    expect(body.mode).toBe("alert");
  });

  it("starts a watch that just keeps track, without destinations", async () => {
    const { props, api } = setup(routes());
    render(<WatchesPage {...props} />);
    fireEvent.change(screen.getByLabelText("What should Senseplane watch for?"), { target: { value: "Someone eating at the kitchen table" } });
    fireEvent.click(await screen.findByRole("button", { name: "Front door" }));
    expect(screen.getByRole("button", { name: "Alert me" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Just keep track" }));
    expect(screen.getByText("Records when it happens so you can ask about it later, without notifications.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: /Send to/ })).toBeNull();
    expect(screen.getByText("Then keep a record")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start watching" }));
    await waitFor(() => expect(api.called("POST", "/watches")).toHaveLength(1));
    const body = api.called("POST", "/watches")[0]!.body;
    expect(body.mode).toBe("track");
    expect(body.notify).toBeUndefined();
  });

  it("marks tracking watches and switches mode from the menu", async () => {
    const { props, api } = setup(routes({ "GET /watches": page([watch(3, { instruction: "Eating at the table", mode: "track" })]) }));
    render(<WatchesPage {...props} />);
    const row = (await screen.findByText("Eating at the table")).closest(".adm-watch") as HTMLElement;
    expect(within(row).getByText("Tracking")).toBeTruthy();
    expect(within(row).getByText("Keeping a record")).toBeTruthy();
    expect(within(row).queryByText(/^→ /)).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /Watch options/ }));
    fireEvent.click(within(row).getByRole("menuitem", { name: "Alert me instead" }));
    await waitFor(() => expect(api.called("PATCH", `/watches/${watch(3).id}`)[0]?.body).toEqual({ mode: "alert" }));
    await waitFor(() => expect(within(row).queryByText("Tracking")).toBeNull());
    expect((await screen.findByText("“Eating at the table” alerts you again.")).getAttribute("role")).toBe("status");
  });

  it("adds a pack to chosen cameras with the browser's time zone", async () => {
    const { props, api } = setup(routes());
    render(<WatchesPage {...props} />);
    await screen.findByText("Tell me when someone is at the front door");
    fireEvent.click(screen.getByRole("button", { name: "Add a pack" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a pack" });
    expect(await within(dialog).findByText("Meals, sleep and getting up at night.")).toBeTruthy();
    expect(within(dialog).getByText("Tracking")).toBeTruthy();
    expect(within(dialog).getByText("23:00–06:00")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Up at night/ }));
    expect(within(dialog).getByText("1 of 2")).toBeTruthy();
    const add = within(dialog).getByRole("button", { name: "Add 1 watch" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true); // no camera yet
    fireEvent.click(within(dialog).getByRole("button", { name: "Loading dock" }));
    fireEvent.click(add);
    expect((await screen.findByText("Added 1 watch from Eldercare.")).getAttribute("role")).toBe("status");
    expect(api.called("POST", "/watch-packs/eldercare/apply")[0]!.body).toEqual({ sources: [SRC.dock], items: ["meals"], time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(api.called("GET", "/watches").length).toBe(2));
  });

  it("tests a watch on the last hour", async () => {
    const { props, api } = setup(routes());
    render(<WatchesPage {...props} />);
    fireEvent.change(screen.getByLabelText("What should Senseplane watch for?"), { target: { value: "Is the dock open" } });
    fireEvent.click(await screen.findByRole("button", { name: "Loading dock" }));
    fireEvent.click(screen.getByRole("button", { name: "Test on last hour" }));
    expect(await screen.findByText(/1 match in the last hour · 3 AI checks used/)).toBeTruthy();
    const body = api.called("POST", "/watches/test")[0]!.body;
    expect(new Date(body.to).getTime() - new Date(body.from).getTime()).toBe(3_600_000);
  });

  it("says when testing is not available", async () => {
    // An unrouted endpoint answers 404 "route not found".
    const r: Record<string, unknown> = routes();
    delete r["POST /watches/test"];
    const { props } = setup(r);
    render(<WatchesPage {...props} />);
    fireEvent.change(screen.getByLabelText("What should Senseplane watch for?"), { target: { value: "Is the dock open" } });
    fireEvent.click(await screen.findByRole("button", { name: "Loading dock" }));
    fireEvent.click(screen.getByRole("button", { name: "Test on last hour" }));
    expect(await screen.findByText(/Testing a watch on recorded video isn't available on this server yet/)).toBeTruthy();
  });

  it("pauses a watch with the switch", async () => {
    const { props, api } = setup(routes());
    render(<WatchesPage {...props} />);
    const sw = await screen.findByRole("switch", { name: /front door/ });
    fireEvent.click(sw);
    await waitFor(() => expect(api.called("PATCH", `/watches/${watch(1).id}`)[0]?.body).toEqual({ status: "paused" }));
  });

  it("disables the composer for viewers", async () => {
    const { props } = setup(routes({ "GET /me": me("viewer") }));
    render(<WatchesPage {...props} />);
    expect(await screen.findByText("Viewers can look but not change anything.")).toBeTruthy();
    expect((screen.getByLabelText("What should Senseplane watch for?") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Start watching" }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getAllByRole("switch")[0] as HTMLButtonElement).disabled).toBe(true));
  });

  it("shows server errors from create", async () => {
    const { props } = setup(routes({ "POST /watches": fail(422, "validation_failed", "instruction is too vague") }));
    render(<WatchesPage {...props} />);
    fireEvent.change(screen.getByLabelText("What should Senseplane watch for?"), { target: { value: "stuff" } });
    fireEvent.click(await screen.findByRole("button", { name: "Front door" }));
    fireEvent.click(screen.getByRole("button", { name: "Start watching" }));
    expect((await screen.findByRole("alert")).textContent).toBe("instruction is too vague");
  });

  it("describes triggers and schedules in words", () => {
    expect(describeTrigger({ type: "sensor", sense: "temperature", above: 27, min_duration_s: 300 } as never)).toBe("temperature > 27 for 5 min");
    expect(describeTrigger({ type: "objects", label: "vehicle", on: "present", min_count: 24 } as never)).toBe("vehicles ≥ 24");
    expect(describeTrigger({ type: "objects", label: "cup", on: "stationary", zone: "desk", min_duration_s: 60 } as never)).toBe("cup stays still in desk for 1 min");
    expect(describeTrigger({ type: "objects", label: "laptop", on: "leave", min_duration_s: 30 } as never)).toBe("laptop gone for 30 s");
    expect(describeTrigger({ type: "objects", label: "person", on: "leave" } as never)).toBe("person leaves");
    expect(describeTrigger({ type: "objects", label: "teddy_bear", on: "present" } as never)).toBe("teddy bear seen");
    expect(describeTrigger({ type: "objects", label: "tv", on: "present", min_count: 2 } as never)).toBe("TVs ≥ 2");
    expect(describeTrigger({ type: "condition", query: {}, test: { op: "lt", value: 1 }, at: "10:00" } as never)).toBe("Checked daily at 10:00");
    expect(describeTrigger({ type: "condition", query: {}, test: { op: "lt", value: 1 }, at: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] } as never)).toBe("Checked on weekdays at 09:00");
    expect(describeTrigger({ type: "condition", query: {}, test: { op: "gt", value: 3 }, every_min: 10 } as never)).toBe("Checked every 10 min");
    expect(describeTrigger({ type: "digest", at: "20:00", items: [{ label: "Meals", query: {} }, { label: "Sleep", query: {} }] } as never)).toBe("Summary at 20:00: Meals, Sleep");
    expect(activeLabel(null)).toBe("Always");
    expect(activeLabel(activeHours("nights", { from: "", to: "" }, "UTC"))).toBe("18:00–06:00");
    expect(activeLabel(activeHours("weekdays", { from: "", to: "" }, "UTC"))).toBe("Weekdays only");
  });
});
