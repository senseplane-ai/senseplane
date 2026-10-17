// @vitest-environment jsdom
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EventsPage, kindOf } from "./EventsPage";
import { SRC, agent, event, me, page, setup, sources, watch, webhook } from "./test-utils";

const fired = event(1, { type: "watch.triggered", watch_id: watch(1).id, verified: true, summary: "Someone is waiting at the front door." });
const offline = event(2, { type: "source.offline", source: { id: SRC.dock, sense: "video" }, summary: "Loading dock stopped sending video.", confidence: null });
const person = event(3);

function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /me": me("owner"),
    "GET /sources": sources(),
    "GET /watches": page([watch(1, { instruction: "Tell me when someone is at the front door", notify: [{ type: "webhook", id: webhook(1).id }, { type: "agent", id: agent(1, "Claude").id }] })]),
    "GET /webhooks": page([webhook(1, { url: "https://ops.example.com/hooks", events: ["watch.triggered", "detection.person"] })]),
    "GET /agents": page([agent(1, "Claude")]),
    "GET /events": (r: { query: URLSearchParams }) => {
      if (r.query.get("cursor") === "c2") return page([event(9, { summary: "An older event." })]);
      const all = [fired, offline, person].filter((e) => !r.query.get("type") || e.type === r.query.get("type")).filter((e) => !r.query.get("source") || e.source.id === r.query.get("source"));
      return page(all, "c2");
    },
    "GET /events/:id": (r: { params: { id: string } }) => [fired, offline, person, event(9)].find((e) => e.id === r.params.id),
    "POST /events/:id/feedback": undefined,
    ...over,
  };
}

describe("EventsPage", () => {
  it("lists events with the Verified mark and shows the first one in detail", async () => {
    const { props } = setup(routes());
    render(<EventsPage {...props} />);
    const list = await screen.findByRole("region", { name: "Event list" });
    await within(list).findByText("Someone is waiting at the front door.");
    expect(within(list).getAllByText("Verified")).toHaveLength(1);
    const detail = screen.getByRole("region", { name: "Event detail" });
    expect(await within(detail).findByText("Tell me when someone is at the front door")).toBeTruthy();
    expect(within(detail).getByText("ops.example.com webhook and Claude (agent)")).toBeTruthy();
    expect(within(detail).getByText("Yes, confirmed by the AI")).toBeTruthy();
  });

  it("filters by kind and camera", async () => {
    const { props, api } = setup(routes());
    render(<EventsPage {...props} />);
    await screen.findByText("A person was seen 3.");
    fireEvent.click(screen.getByRole("button", { name: "Watches fired" }));
    await waitFor(() => expect(screen.queryByText("A person was seen 3.")).toBeNull());
    expect(api.calls.some((c) => c.path === "/events" && c.query.get("type") === "watch.triggered")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Alerts" }));
    await screen.findAllByText("Loading dock stopped sending video.");
    expect(screen.queryByText("Someone is waiting at the front door.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await screen.findByRole("option", { name: "Loading dock" });
    fireEvent.change(screen.getByRole("combobox", { name: "Camera" }), { target: { value: SRC.dock } });
    await waitFor(() => expect(api.calls.some((c) => c.path === "/events" && c.query.get("source") === SRC.dock)).toBe(true));
  });

  it("sends feedback and loads older events", async () => {
    const { props, api } = setup(routes());
    render(<EventsPage {...props} />);
    await screen.findByText("Someone is waiting at the front door.", { selector: "h2" });
    fireEvent.click(screen.getByRole("button", { name: "Not relevant" }));
    await screen.findByText(/Feedback tunes this camera/);
    expect(api.called("POST", `/events/${fired.id}/feedback`)[0]!.body).toEqual({ feedback: "not_relevant" });

    fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
    await screen.findByText("An older event.");
  });

  it("disables feedback for viewers", async () => {
    const { props } = setup(routes({ "GET /me": me("viewer") }));
    render(<EventsPage {...props} />);
    await screen.findByText("Someone is waiting at the front door.", { selector: "h2" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Yes" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("explains when the server has no events feed", async () => {
    const { props } = setup({ "GET /sources": sources() });
    render(<EventsPage {...props} />);
    expect(await screen.findByText(/isn't available on this server yet/)).toBeTruthy();
  });

  it("maps types to kinds", () => {
    expect(kindOf("watch.triggered")).toBe("watch");
    expect(kindOf("detection.vehicle")).toBe("det");
    expect(kindOf("sound.detected")).toBe("det");
    expect(kindOf("reading.threshold")).toBe("alert");
  });
});
