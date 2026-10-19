// @vitest-environment jsdom
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentsPage, mcpUrl } from "./AgentsPage";
import { SRC, agent, isoAgo, me, page, setup, sources } from "./test-utils";

const claude = agent(1, "Claude Code", { kind: "app", client_name: "Claude Code", redirect_host: "localhost", connected_at: "2026-10-03T00:00:00Z", last_active_at: isoAgo(5 * 60_000) });
const ops = agent(2, "ops-bot", { kind: "key", last_active_at: null });
const grants = [
  { id: "grt_1", agent_id: claude.id, source_ids: [SRC.front, SRC.dock, SRC.lobby], senses: ["video", "audio"], abilities: ["watch"], created_at: "2026-10-02T00:00:00Z" },
  { id: "grt_2", agent_id: ops.id, source_ids: [SRC.front], senses: ["video"], abilities: ["watch", "history"], window: { from: "2026-10-01T00:00:00Z" }, created_at: "2026-10-02T00:00:00Z" },
];

function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /me": me("owner"),
    "GET /sources": sources(),
    "GET /agents": page([claude, ops]),
    "GET /grants": page(grants),
    "POST /agents": (r: { body: { name: string } }) => ({ ...agent(3, r.body.name, { kind: "key" }), api_key: "sk_live_secret_once" }),
    "POST /grants": (r: { body: object }) => ({ id: "grt_9", created_at: "2026-10-16T00:00:00Z", ...r.body }),
    "DELETE /grants/:id": undefined,
    "DELETE /agents/:id": undefined,
    ...over,
  };
}
const card = (name: string) => screen.getByRole("listitem", { name });

describe("AgentsPage", () => {
  it("leads with connected apps: when, last active, what each can use", async () => {
    const { props } = setup(routes());
    render(<AgentsPage {...props} />);
    expect(screen.getByRole("heading", { name: "Connected apps", level: 1 })).toBeTruthy();
    await screen.findByRole("listitem", { name: "Claude Code" });
    const apps = within(screen.getByRole("list", { name: "Connected apps" }));
    expect(apps.queryByText("ops-bot")).toBeNull();
    const c = within(card("Claude Code"));
    expect(c.getByText(/Connected .* · Last active 5 min ago · via localhost/)).toBeTruthy();
    await waitFor(() => expect(c.getByText("All cameras and sensors")).toBeTruthy());
    for (const p of ["Look", "Listen", "Set watches"]) expect(c.getByText(p)).toBeTruthy();
    expect(c.queryByText("See history and replay")).toBeNull();
    expect(c.getByRole("button", { name: "Disconnect Claude Code" })).toBeTruthy();
  });

  it("explains how to connect an app when none is connected, with the MCP URL", async () => {
    const { props } = setup(routes({ "GET /agents": page([ops]) }));
    render(<AgentsPage {...props} />);
    expect(await screen.findByRole("heading", { name: "No apps connected yet" })).toBeTruthy();
    expect(screen.getAllByText("http://sp.test/mcp").length).toBeGreaterThan(0);
    expect(screen.getByText("claude mcp add --transport http senseplane http://sp.test/mcp")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Cursor" }));
    expect(screen.getByText('{ "mcpServers": { "senseplane": { "url": "http://sp.test/mcp" } } }')).toBeTruthy();
    expect(mcpUrl("/api/v1")).toBe(`${location.origin}/mcp`);
    expect(document.body.textContent).not.toMatch(/senseplane\.com/);
    expect(document.body.textContent).not.toMatch(/paste/i);
  });

  it("edits an app's access in place with the consent picker", async () => {
    const { props, api } = setup(routes());
    render(<AgentsPage {...props} />);
    await screen.findByRole("listitem", { name: "Claude Code" });
    fireEvent.click(within(card("Claude Code")).getByRole("button", { name: "Edit access for Claude Code" }));
    const c = within(card("Claude Code"));
    fireEvent.click(c.getByRole("button", { name: "Reception" }));
    fireEvent.click(c.getByRole("button", { name: "Listen" }));
    fireEvent.click(c.getByRole("button", { name: "See history and replay" }));
    fireEvent.click(c.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(api.called("DELETE", "/grants/grt_1")).toHaveLength(1));
    expect(api.called("POST", "/grants")[0]!.body).toEqual({ agent_id: claude.id, source_ids: [SRC.front, SRC.dock], senses: ["video"], abilities: ["watch", "history"] });
  });

  it("disconnects an app after confirming", async () => {
    const { props, api } = setup(routes());
    render(<AgentsPage {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Claude Code" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/on every device it connected from/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(api.called("DELETE", `/agents/${claude.id}`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Claude Code" })).toBeNull());
  });

  it("keeps API keys in a developer section, keeps a key's window, and shows a new key once", async () => {
    const { props, api } = setup(routes());
    render(<AgentsPage {...props} />);
    const keys = within(await screen.findByRole("list", { name: "API keys" }));
    expect(keys.getByText(/Key sk_ab2… · Created .* · Last used never/)).toBeTruthy();
    expect(keys.getByText(/only from/)).toBeTruthy();
    expect(screen.getByText("For developers")).toBeTruthy();

    fireEvent.click(keys.getByRole("button", { name: "Edit access for ops-bot" }));
    fireEvent.click(within(card("ops-bot")).getByRole("button", { name: "Loading dock" }));
    fireEvent.click(within(card("ops-bot")).getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(api.called("DELETE", "/grants/grt_2")).toHaveLength(1));
    expect(api.called("POST", "/grants")[0]!.body).toMatchObject({ source_ids: [SRC.front, SRC.dock], window: { from: "2026-10-01T00:00:00Z" } });

    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "night-bot" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Front door" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Listen" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create key" }));
    expect(await screen.findByText("sk_live_secret_once")).toBeTruthy();
    expect(screen.getByText(/shown only once/)).toBeTruthy();
    expect(api.called("POST", "/grants").at(-1)!.body).toEqual({ agent_id: agent(3, "x").id, source_ids: [SRC.front], senses: ["video", "audio"], abilities: [] });
  });

  it("lets an owner create and revoke a workspace key, shown once", async () => {
    let keys = [{ id: "key_1", name: "Load test", key_prefix: "sk_abcd", created_at: "2026-10-18T00:00:00Z", last_used_at: null }];
    const { props, api } = setup(routes({
      "GET /keys": () => page(keys),
      "POST /keys": (r: { body: { name: string } }) => ({ id: "key_2", name: r.body.name, key_prefix: "sk_newk", created_at: "2026-10-19T00:00:00Z", last_used_at: null, api_key: "sk_newkey_secret" }),
      "DELETE /keys/:id": (r: { params: { id: string } }) => { keys = keys.filter((k) => k.id !== r.params.id); return undefined; },
    }));
    render(<AgentsPage {...props} />);
    const list = await screen.findByRole("list", { name: "Workspace keys" });
    expect(within(list).getByText(/Key sk_abcd…/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create workspace key" }));
    const dialog = await screen.findByRole("dialog", { name: "Create a workspace key" });
    fireEvent.change(within(dialog).getByPlaceholderText("My app"), { target: { value: "My app" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create key" }));
    expect(await screen.findByText("sk_newkey_secret")).toBeTruthy();
    expect(api.called("POST", "/keys")[0]!.body).toEqual({ name: "My app" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke workspace key Load test" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(api.called("DELETE", "/keys/key_1")).toHaveLength(1));
  });

  it("shows workspace keys to admins without letting them make one", async () => {
    const { props } = setup(routes({ "GET /me": me("admin"), "GET /keys": page([]) }));
    render(<AgentsPage {...props} />);
    expect(await screen.findByText(/Only owners can create or revoke them/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create workspace key" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables changes for members", async () => {
    const { props } = setup(routes({ "GET /me": me("member") }));
    render(<AgentsPage {...props} />);
    await screen.findByRole("listitem", { name: "Claude Code" });
    await waitFor(() => expect((screen.getByRole("button", { name: "Create API key" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Disconnect Claude Code" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Edit access for Claude Code" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
