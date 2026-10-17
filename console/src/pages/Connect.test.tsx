// @vitest-environment jsdom
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { shareSession } from "../session";
import { SRC, agent, me, page, setup, sources } from "./admin/test-utils";
import { ConnectPage, appHost } from "./Connect";

const BINDING = "b".repeat(43);
const info = (over: object = {}) => ({ client_name: "Claude Code", redirect_host: "127.0.0.1:33418", verified: false, binding: BINDING, expires_at: "2026-10-17T12:00:00Z", ...over });

function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /oauth/request": info(),
    "GET /me": me("owner"),
    "GET /sources": sources(),
    "GET /agents": page([]),
    "GET /grants": page([]),
    "POST /agents/connect": (r: { body: { client_name: string } }) => ({ agent: agent(7, r.body.client_name, { kind: "app" }), code: "cc_code", expires_at: "2026-10-17T12:02:00Z", reused: false }),
    ...over,
  };
}

function open(over: Record<string, unknown> = {}, props: { apiKey?: string } = { apiKey: "sk_session" }) {
  const { api } = setup(routes(over));
  const post = vi.fn();
  const onSession = vi.fn();
  const onSignOut = vi.fn();
  const onDone = vi.fn();
  render(<ConnectPage request="sealed_req" apiUrl="http://sp.test/v1" authUrl="http://sp.test/auth" apiKey={props.apiKey} post={post} onSession={onSession} onSignOut={onSignOut} onDone={onDone} />);
  return { api, post, onSession, onSignOut, onDone };
}

describe("ConnectPage (MCP consent)", () => {
  it("matches the API's notion of the same app", () => {
    expect(appHost("127.0.0.1:33418")).toBe("localhost");
    expect(appHost("claude.ai")).toBe("claude.ai");
  });

  it("names the app and where access goes, warns when unverified, and asks to sign in without a session", async () => {
    const { post } = open({}, {});
    expect(await screen.findByRole("heading", { name: "Sign in to connect Claude Code" }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:33418", { selector: ".consent-host code" })).toBeInTheDocument();
    expect(screen.getByText(/This app is not verified/)).toBeInTheDocument();
    expect(screen.getByLabelText("Work email")).toBeInTheDocument();
    expect(screen.queryByText(/API key/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel and go back" }));
    expect(post).toHaveBeenCalledWith("http://sp.test/oauth/deny", { request: "sealed_req" });
  });

  it("borrows the session of another open console tab", async () => {
    const stop = shareSession("sk_other_tab");
    const { onSession } = open({}, {});
    await waitFor(() => expect(onSession).toHaveBeenCalledWith("sk_other_tab"));
    stop();
  });

  it("lets an admin pick sources and permissions, then hands the MCP service a connect code", async () => {
    const { api, post } = open();
    expect(await screen.findByRole("heading", { name: "Claude Code wants to use your cameras" })).toBeInTheDocument();
    // Everything is picked by default except listening (audio is opt-in).
    const allow = await screen.findByRole("button", { name: "Allow" });
    expect(screen.getByRole("button", { name: "All cameras" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Listen" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Reception" }));
    fireEvent.click(screen.getByRole("button", { name: "See history and replay" }));
    fireEvent.click(allow);
    await waitFor(() => expect(post).toHaveBeenCalledWith("http://sp.test/oauth/approve", { request: "sealed_req", code: "cc_code" }));
    expect(api.called("POST", "/agents/connect")[0]!.body).toEqual({
      client_name: "Claude Code", redirect_host: "127.0.0.1:33418", binding: BINDING,
      source_ids: [SRC.front, SRC.dock], senses: ["video", "temperature", "humidity"], abilities: ["watch"],
    });
  });

  it("needs something to sense with before Allow", async () => {
    open();
    const allow = await screen.findByRole("button", { name: "Allow" });
    for (const name of ["Look", "Read environment"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(allow).toBeDisabled();
    expect(screen.getByText("Pick at least one of Look, Listen or Read environment.")).toBeInTheDocument();
  });

  it("pre-fills a reconnecting app's current access", async () => {
    const app = agent(5, "Claude Code", { kind: "app", client_name: "Claude Code", redirect_host: "localhost" });
    open({
      "GET /agents": page([app]),
      "GET /grants": page([{ id: "grt_1", agent_id: app.id, source_ids: [SRC.dock], senses: ["video", "audio"], abilities: [], created_at: "2026-10-02T00:00:00Z" }]),
    });
    expect(await screen.findByText(/is already connected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Loading dock" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Front door" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Listen" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Set watches" })).toHaveAttribute("aria-pressed", "false");
  });

  it("tells members to ask an admin and only offers Cancel", async () => {
    const { post } = open({ "GET /me": me("member") });
    expect(await screen.findByText(/Only admins and owners of Northwind Ops can connect apps/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(post).toHaveBeenCalledWith("http://sp.test/oauth/deny", { request: "sealed_req" });
  });

  it("marks trusted hosts as verified", async () => {
    open({ "GET /oauth/request": info({ redirect_host: "claude.ai", verified: true, client_name: "Claude" }) });
    expect(await screen.findByText("(verified)", { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(/This app is not verified/)).toBeNull();
  });

  it("explains an expired request", async () => {
    const { onDone } = open({ "GET /oauth/request": { __reply: true, status: 410, json: { error: "invalid_request", error_description: "This connection request expired. Start again from your app." } } });
    expect(await screen.findByRole("heading", { name: "This request can't be used" })).toBeInTheDocument();
    expect(screen.getByText("This connection request expired. Start again from your app.")).toBeInTheDocument();
    fireEvent.click(within(document.body).getByRole("button", { name: "Go to Senseplane" }));
    expect(onDone).toHaveBeenCalled();
  });
});
