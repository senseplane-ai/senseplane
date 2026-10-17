// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { resolveRoute } from "./App";
import { Link, matchPath, navigate, useLocation } from "./router";

describe("matchPath", () => {
  it("matches params and rejects other paths", () => {
    expect(matchPath("/cameras/:id", "/cameras/src_1")).toEqual({ id: "src_1" });
    expect(matchPath("/cameras/:id", "/cameras/src_1/")).toEqual({ id: "src_1" });
    expect(matchPath("/cameras/:id", "/cameras")).toBeNull();
    expect(matchPath("/cameras/:id", "/cameras/a/b")).toBeNull();
    expect(matchPath("/events/*", "/events/evt_1/x")).toEqual({});
    expect(matchPath("/chats/:id", "/chats/a%20b")).toEqual({ id: "a b" });
  });
});

describe("resolveRoute", () => {
  it.each([
    ["/", "ask"], ["/chats/cnv_1", "ask"], ["/cameras", "cameras"], ["/cameras/new", "add-camera"],
    ["/cameras/src_1", "camera"], ["/live", "live"], ["/events", "/events"], ["/watches", "/watches"],
    ["/search", "/search"], ["/agents", "/agents"], ["/webhooks", "/webhooks"], ["/usage", "/usage"],
    ["/settings", "/settings"], ["/settings/team", "/settings"], ["/nope", "not-found"],
  ])("%s → %s", (path, page) => {
    expect(resolveRoute(path).page).toBe(page);
  });

  it("renders Add camera without the shell", () => {
    expect(resolveRoute("/cameras/new").bare).toBe(true);
  });
});

function Where() {
  const { pathname, search } = useLocation();
  return <output>{pathname}{search.toString() ? `?${search}` : ""}</output>;
}

describe("navigation", () => {
  it("navigate() updates subscribers and history", () => {
    render(<Where />);
    act(() => navigate("/cameras/src_1?t=2026"));
    expect(screen.getByRole("status")).toHaveTextContent("/cameras/src_1?t=2026");
    expect(location.pathname).toBe("/cameras/src_1");
    act(() => {
      history.back();
    });
  });

  it("Link navigates in-app on a plain click and leaves modified clicks to the browser", () => {
    render(<><Link to="/live">Live view</Link><Where /></>);
    const a = screen.getByRole("link", { name: "Live view" });
    expect(a).toHaveAttribute("href", "/live");
    fireEvent.click(a, { metaKey: true });
    expect(screen.getByRole("status")).toHaveTextContent("/");
    fireEvent.click(a);
    expect(screen.getByRole("status")).toHaveTextContent("/live");
  });

  it("follows popstate (back/forward)", () => {
    render(<Where />);
    act(() => {
      history.pushState(null, "", "/usage");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("status")).toHaveTextContent("/usage");
  });
});
