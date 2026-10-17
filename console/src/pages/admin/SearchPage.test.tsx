// @vitest-environment jsdom
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SearchPage, groupByDay } from "./SearchPage";
import { SRC, event, me, page, setup, sources } from "./test-utils";

const today = event(1, { summary: "Courier leaves a parcel", occurred_at: new Date().toISOString() });
const yesterday = event(2, { summary: "Van parks outside", type: "detection.vehicle", labels: ["vehicle"], source: { id: SRC.dock, sense: "video" }, occurred_at: new Date(Date.now() - 86_400_000).toISOString() });
const clip = { id: "clp_1", source_id: SRC.front, title: "Parcel delivery", from: "2026-10-16T11:41:00Z", to: "2026-10-16T11:43:00Z", duration_ms: 120_000, bytes: 1000, created_at: "2026-10-16T12:00:00Z" };

function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /me": me("owner"),
    "GET /sources": sources(),
    "GET /memory/search": { data: [{ event: today, score: 0.96 }, { event: yesterday, score: 0.62 }] },
    "GET /clips": page([clip]),
    "GET /clips/:id": { ...clip, playback_url: "https://media.test/clip.m3u8" },
    "DELETE /clips/:id": undefined,
    ...over,
  };
}

const search = (q: string) => {
  const box = screen.getByRole("searchbox");
  fireEvent.change(box, { target: { value: q } });
  fireEvent.submit(box.closest("form")!);
};

describe("SearchPage", () => {
  it("groups results by day with match % and opens playback at that moment", async () => {
    const { props, api, navigate } = setup(routes());
    render(<SearchPage {...props} />);
    search("courier");
    const day = await screen.findByRole("region", { name: "Today" });
    expect(within(day).getByText("96%")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Yesterday" })).toBeTruthy();
    expect(api.called("GET", "/memory/search")[0]!.query.get("q")).toBe("courier");
    fireEvent.click(within(day).getByRole("button", { name: /Courier leaves a parcel/ }));
    expect(navigate).toHaveBeenCalledWith(`/cameras/${SRC.front}?t=${encodeURIComponent(today.occurred_at)}`);
  });

  it("filters by camera and kind", async () => {
    const { props } = setup(routes());
    render(<SearchPage {...props} />);
    search("anything");
    await screen.findByText("Van parks outside");
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "people" } });
    expect(screen.queryByText("Van parks outside")).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "all" } });
    await screen.findByRole("option", { name: "Loading dock" });
    fireEvent.change(screen.getByRole("combobox", { name: "Cameras" }), { target: { value: SRC.dock } });
    expect(screen.queryByText("Courier leaves a parcel")).toBeNull();
    expect(screen.getByText("Van parks outside")).toBeTruthy();
  });

  it("lists saved clips and deletes one after confirming", async () => {
    const { props, api } = setup(routes());
    render(<SearchPage {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: /Saved clips/ }));
    expect(await screen.findByText("Parcel delivery")).toBeTruthy();
    expect(screen.getByText("2:00")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete Parcel delivery" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete clip" }));
    await waitFor(() => expect(screen.queryByText("Parcel delivery")).toBeNull());
    expect(api.called("DELETE", "/clips/clp_1")).toHaveLength(1);
  });

  it("disables clip deletion for viewers", async () => {
    const { props } = setup(routes({ "GET /me": me("viewer") }));
    render(<SearchPage {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: /Saved clips/ }));
    await screen.findByText("Parcel delivery");
    await waitFor(() => expect((screen.getByRole("button", { name: "Delete Parcel delivery" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("explains when search is not available", async () => {
    const r: Record<string, unknown> = routes();
    delete r["GET /memory/search"];
    const { props } = setup(r);
    render(<SearchPage {...props} />);
    search("courier");
    expect(await screen.findByText(/Search isn't available on this server yet/)).toBeTruthy();
  });

  it("orders days newest first", () => {
    const g = groupByDay([{ event: yesterday as never, score: 0.9 }, { event: today as never, score: 0.5 }]);
    expect(g.map((x) => x.day)).toEqual(["Today", "Yesterday"]);
  });
});
