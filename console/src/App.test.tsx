// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** A fetch for the whole app: auth providers, and a /v1 that answers with `v1(path)`. */
function stubApi(v1: (path: string, method: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const path = new URL(url, location.origin).pathname;
    if (path.endsWith("/auth/providers")) return json({ password: true, google: false, github: false, signup: true, challenge: null });
    if (path.endsWith("/auth/logout")) return new Response(null, { status: 204 });
    if (path.endsWith("/auth/login")) return json({ session: "sk_session" });
    return v1(path.replace(/^.*\/v1/, ""), method);
  }));
}

const okApi = (path: string) => {
  if (path === "/sources") return json({ data: [], next_cursor: null });
  if (path === "/account") return json({ id: "acc_1", name: "Northwind Ops", retention_days: 7, limits: { live_view: true } });
  if (path === "/conversations") return json({ data: [{ id: "cnv_1", title: "Courier", created_at: "", updated_at: "" }], next_cursor: null });
  if (path === "/events" || path === "/watches") return json({ data: [], next_cursor: null });
  return json({ error: { code: "not_found", message: "not found" } }, 404);
};

describe("App session", () => {
  it("asks you to sign in without a session, then opens the console on the same deep link", async () => {
    history.replaceState(null, "", "/cameras");
    stubApi(okApi);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Work email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "long enough pw");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "No cameras yet" })).toBeInTheDocument();
    expect(sessionStorage.getItem("senseplane.apiKey")).toBe("sk_session");
    expect(await screen.findByRole("link", { name: "Courier" })).toBeInTheDocument();
  });

  it("signs out from the user block", async () => {
    sessionStorage.setItem("senseplane.apiKey", "sk_session");
    stubApi(okApi);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(sessionStorage.getItem("senseplane.apiKey")).toBeNull();
  });

  it("returns to sign-in with a notice when the session has expired", async () => {
    sessionStorage.setItem("senseplane.apiKey", "sk_old");
    stubApi(() => json({ error: { code: "unauthorized", message: "expired" } }, 401));
    render(<App />);
    expect(await screen.findByText("Your session ended. Sign in again.")).toBeInTheDocument();
  });

  it("renders admin pages from the admin index at their routes", async () => {
    sessionStorage.setItem("senseplane.apiKey", "sk_session");
    history.replaceState(null, "", "/webhooks");
    stubApi(okApi);
    render(<App />);
    expect(await screen.findByRole("link", { name: "Webhooks" })).toHaveAttribute("aria-current", "page");
  });
});
