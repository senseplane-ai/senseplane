// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { appData, fakeFetch, renderWithApp, source } from "../test/render";
import { AddCameraPage, connectLines } from "./AddCamera";

const created = (over: object) => source({ id: "src_new", name: "Loading dock", status: "pending", ...over });

function withBodies(routes: Parameters<typeof fakeFetch>[0]) {
  const bodies: unknown[] = [];
  const f = fakeFetch(routes);
  const wrapped: typeof fetch = async (input, init) => {
    const req = input as Request;
    if (typeof input === "object" && "url" in input && req.method === "POST") bodies.push(await req.clone().json().catch(() => null));
    return f(input, init);
  };
  return { fetch: wrapped, bodies };
}

describe("AddCameraPage", () => {
  it("walks through phone setup: choose, name, scan a real QR, then flips to connected", async () => {
    let status = "pending";
    const { fetch, bodies } = withBodies({
      "POST /sources": created({ ingest: { capture_url: "https://console.test/capture.html#t=abc", token: "abc" } }),
      "GET /sources/src_new": () => Response.json(created({ status })),
    });
    renderWithApp(<AddCameraPage />, appData({ fetch }));
    expect(screen.getByRole("heading", { name: "What are you connecting?" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByRole("radio", { name: /Phone or laptop/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    await userEvent.type(screen.getByLabelText("Name"), "Loading dock");
    await userEvent.type(screen.getByLabelText("Where is it?"), "Warehouse");
    await userEvent.click(screen.getByRole("switch", { name: "Record audio" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Scan to connect" })).toBeInTheDocument();
    expect(bodies[0]).toEqual({ name: "Loading dock", location: "Warehouse", type: "browser", record_audio: true });
    await waitFor(() => expect(screen.getByRole("img", { name: "QR code for the capture link" }).querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png/));
    expect(screen.getByRole("link", { name: "Use this computer" })).toHaveAttribute("href", "https://console.test/capture.html#t=abc");
    expect(screen.getByText("Waiting for the phone to connect…")).toBeInTheDocument();
    status = "online";
    expect(await screen.findByText("Connected. Loading dock is streaming.", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("moves between the selectable kinds with the arrow keys", async () => {
    renderWithApp(<AddCameraPage />, appData());
    screen.getByRole("radio", { name: /Phone or laptop/ }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: /OBS or streaming software/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /OBS/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}"); // skips the ones coming soon, back to the start
    expect(screen.getByRole("radio", { name: /Phone or laptop/ })).toHaveFocus();
  });

  it("shows WHIP copy blocks from the ingest response", async () => {
    const { fetch } = withBodies({ "POST /sources": created({ type: "whip", ingest: { whip_url: "http://media.test/whip/src_new", token: "whp_secret" } }) });
    renderWithApp(<AddCameraPage />, appData({ fetch }));
    await userEvent.click(screen.getByRole("radio", { name: /OBS/ }));
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await userEvent.type(screen.getByLabelText("Name"), "Studio");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Paste these into your software" })).toBeInTheDocument();
    expect(screen.getByLabelText("Server")).toHaveTextContent("http://media.test/whip/src_new");
    expect(screen.getByLabelText("Bearer token")).toHaveTextContent("whp_secret");
    expect(screen.getByRole("button", { name: "Copy Bearer token" })).toBeInTheDocument();
  });

  it("shows IP cameras and Home Assistant sensors as coming soon, not selectable", async () => {
    renderWithApp(<AddCameraPage />, appData({ fetch: withBodies({}).fetch }));
    for (const name of [/IP camera/, /Home Assistant/]) {
      const r = screen.getByRole("radio", { name });
      expect(r).toBeDisabled();
      expect(r).toHaveTextContent("Coming soon");
    }
  });
});

describe("connectLines", () => {
  it("uses the bridge command and token for IP cameras", () => {
    const s = created({ ingest: { token: "x", docker_command: "docker run senseplane/bridge --token brg_1", bridge_token: "brg_1" } });
    expect(connectLines("ip", s, "/api/v1").map((l) => l.label)).toEqual(["Docker", "Bridge token"]);
  });

  it("falls back to the sensor id for Home Assistant on servers without integration tokens", () => {
    expect(connectLines("ha", created({ type: "sensor" }), "http://api.test/v1")).toEqual([
      { label: "Server", value: "http://api.test" }, { label: "Sensor ID", value: "src_new" },
    ]);
  });
});
