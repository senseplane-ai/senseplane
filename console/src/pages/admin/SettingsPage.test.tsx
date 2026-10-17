// @vitest-environment jsdom
// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsPage, describeAudit } from "./SettingsPage";
import { SRC, me, page, setup, sources } from "./test-utils";

const account = { id: "acc_1", name: "Northwind Ops", time_zone: "Europe/Berlin", retention_days: 7, retention_max_days: 30, retention_mode: "days", created_at: "2026-01-01T00:00:00Z" };
const members = [
  { id: "usr_1", email: "alex@example.com", name: "Alex Morgan", role: "owner" },
  { id: "usr_2", email: "sam@example.com", name: "Sam Kim", role: "admin" },
  { id: "usr_3", email: "jo@example.com", name: "Jo Reyes", role: "viewer" },
];

function routes(over: Record<string, unknown> = {}) {
  return {
    "GET /me": me("owner"),
    "GET /account": account,
    "PATCH /account": (r: { body: object }) => ({ ...account, ...r.body }),
    "GET /sources": sources(),
    "GET /agents": page([]),
    "GET /members": page(members),
    "PATCH /members/:id": (r: { params: { id: string }; body: { role: string } }) => ({ ...members.find((m) => m.id === r.params.id), role: r.body.role }),
    "GET /invites": page([]),
    "POST /invites": (r: { body: { email: string; role: string } }) => ({ id: "inv_1", ...r.body, invite_url: "http://console.test/invite#tok", expires_at: "2026-10-23T00:00:00Z" }),
    "GET /auth/providers": { password: true, google: true, github: false, signup: false },
    "GET /audit": (r: { query: URLSearchParams }) => r.query.get("cursor")
      ? page([{ id: "aud_2", actor: "owner:sk_abcd", action: "POST /v1/watches", target: "wat_1", occurred_at: "2026-10-10T09:00:00Z" }])
      : page([{ id: "aud_1", actor: "agent:agt_1", action: "GET /v1/sources/:id/now", target: SRC.front, occurred_at: new Date().toISOString(), status: 200 }], "next"),
    "DELETE /account": undefined,
    ...over,
  };
}

const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

describe("SettingsPage", () => {
  it("saves the workspace name and time zone", async () => {
    const { props, api } = setup(routes());
    render(<SettingsPage {...props} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Northwind Ops" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Northwind" } });
    fireEvent.change(screen.getByLabelText("Time zone"), { target: { value: "UTC" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(api.called("PATCH", "/account")[0]!.body).toEqual({ name: "Northwind", time_zone: "UTC" });
  });

  it("saves recording defaults within the workspace's maximum", async () => {
    const { props, api } = setup(routes());
    render(<SettingsPage {...props} />);
    await screen.findByRole("heading", { level: 1, name: "Northwind Ops" });
    openTab("Recording defaults");
    fireEvent.change(screen.getByLabelText("Days"), { target: { value: "40" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Until storage is full/));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(api.called("PATCH", "/account")[0]!.body).toEqual({ retention_mode: "fill" });
    expect(screen.getByText("720p")).toBeTruthy();
  });

  it("lists the team, changes a role and creates an invite link", async () => {
    const { props, api } = setup(routes());
    render(<SettingsPage {...props} />);
    openTab("Team");
    expect(await screen.findByText("Sam Kim")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Role for Jo Reyes"), { target: { value: "member" } });
    await waitFor(() => expect(api.called("PATCH", "/members/usr_3")[0]?.body).toEqual({ role: "member" }));
    fireEvent.click(screen.getByRole("button", { name: "Invite someone" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create invite link" }));
    expect(await screen.findByText("http://console.test/invite#tok")).toBeTruthy();
  });

  it("explains when team management is not on this server", async () => {
    const r: Record<string, unknown> = routes();
    delete r["GET /members"];
    delete r["GET /invites"];
    const { props } = setup(r);
    render(<SettingsPage {...props} />);
    openTab("Team");
    expect(await screen.findByText(/Team members isn't available on this server yet/)).toBeTruthy();
  });

  it("disables team and workspace changes for viewers", async () => {
    const { props } = setup(routes({ "GET /me": me("viewer") }));
    render(<SettingsPage {...props} />);
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true));
    openTab("Team");
    await screen.findByText("Sam Kim");
    expect((screen.getByRole("button", { name: "Invite someone" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Role for Jo Reyes") as HTMLSelectElement).disabled).toBe(true);
    openTab("Your data");
    expect(screen.queryByRole("button", { name: "Delete workspace" })).toBeNull();
  });

  it("shows sign-in methods read-only", async () => {
    const { props } = setup(routes());
    render(<SettingsPage {...props} />);
    openTab("Sign-in");
    expect(await screen.findByLabelText("Google: on")).toBeTruthy();
    expect(screen.getByLabelText("GitHub: off")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("pages through the audit log in words", async () => {
    const { props } = setup(routes({ "GET /agents": page([{ id: "agt_1", name: "Claude", created_at: "2026-10-01T00:00:00Z" }]) }));
    render(<SettingsPage {...props} />);
    openTab("Audit log");
    expect(await screen.findByText("Looked at Front door")).toBeTruthy();
    expect(await screen.findByText("Claude")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText("Created a watch")).toBeTruthy();
    expect(screen.getByText("Owner key sk_abcd…")).toBeTruthy();
  });

  it("deletes the workspace only after typing its name", async () => {
    const { props, api, navigate } = setup(routes());
    render(<SettingsPage {...props} />);
    await screen.findByRole("heading", { level: 1, name: "Northwind Ops" });
    openTab("Your data");
    fireEvent.click(screen.getByRole("button", { name: "Delete workspace" }));
    const dialog = screen.getByRole("dialog");
    const go = within(dialog).getByRole("button", { name: "Delete workspace" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Northwind Ops" } });
    fireEvent.click(go);
    await waitFor(() => expect(api.called("DELETE", "/account")).toHaveLength(1));
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("describes unknown audit actions plainly", () => {
    expect(describeAudit({ id: "a", actor: "x", action: "GET /v1/things", target: "", occurred_at: "" }, (s) => s)).toBe("GET /v1/things");
  });
});
