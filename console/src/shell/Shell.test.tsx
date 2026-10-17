// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { navigate } from "../router";
import { appData, renderWithApp, source } from "../test/render";
import { Shell } from "./Shell";

const cams = [
  source({ id: "src_a", name: "Front door", status: "online" }),
  source({ id: "src_b", name: "Loading dock", status: "offline" }),
  source({ id: "src_c", name: "Server room", type: "sensor", senses: ["temperature"] }),
];

describe("Shell", () => {
  it("shows the designed nav with counts, recent chats and the user", () => {
    const signOut = vi.fn();
    renderWithApp(<Shell><p>content</p></Shell>, appData({
      sources: cams, unreadEvents: 4, signOut,
      conversations: [{ id: "cnv_1", title: "When did the courier come?", created_at: "", updated_at: "" }],
      me: { user: { id: "usr_1", email: "alex@northwind.example", name: "Alex Morgan" }, role: "owner", account: { id: "acc_1", name: "Northwind Ops" } },
    }));
    const nav = screen.getByRole("navigation", { name: "Console" });
    const labels = within(nav).getAllByRole("link").map((a) => a.textContent);
    expect(labels).toEqual(["Ask", "Cameras1/2", "Live view", "Events4", "Watches", "Search history", "Agents", "Webhooks", "Usage", "Settings"]);
    expect(within(nav).getByRole("link", { name: /Ask/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("1 of 2 online")).toBeInTheDocument();
    expect(screen.getByLabelText("4 new")).toBeInTheDocument();
    expect(screen.getByLabelText("Cameras live")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "When did the courier come?" })).toHaveAttribute("href", "/chats/cnv_1");
    expect(screen.getByText("Alex Morgan")).toBeInTheDocument();
    expect(screen.getByText("Northwind Ops")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalled();
  });

  it("marks the current page and hides the live dot when live view is off", () => {
    renderWithApp(<Shell><p /></Shell>, appData({ sources: cams, limits: { ...appData().limits, live_view: false } }));
    act(() => navigate("/cameras/src_a"));
    expect(screen.getByRole("link", { name: /Cameras/ })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByLabelText("Cameras live")).toBeNull();
  });

  it("hides recent chats when the server has no conversations API", () => {
    renderWithApp(<Shell><p /></Shell>, appData({ chatsAvailable: false }));
    expect(screen.queryByText("Recent chats")).toBeNull();
  });

  it("New chat goes home with a fresh chat", () => {
    renderWithApp(<Shell><p /></Shell>, appData());
    act(() => navigate("/chats/cnv_1"));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(location.pathname).toBe("/");
    expect(location.search).toMatch(/^\?new=/);
  });

  it("has a phone menu button that toggles the sidebar", () => {
    renderWithApp(<Shell><p /></Shell>, appData());
    const btn = screen.getByRole("button", { name: "Open menu" });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("sidebar")).toHaveAttribute("data-open");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.getElementById("sidebar")).not.toHaveAttribute("data-open");
  });
});
