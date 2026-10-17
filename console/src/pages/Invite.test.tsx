// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { takeInviteHash } from "../session";
import { InvitePage } from "./Invite";

const providers = { password: true, google: true, github: false, signup: false, challenge: null };
const preview = (over: object = {}) => ({
  workspace: { name: "Northwind Ops" }, email: "sam@example.com", role: "member", expires_at: "2026-10-23T00:00:00Z",
  existing_user: false, has_password: false, ...over,
});

function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    return key ? routes[key]!(init) : new Response("{}", { status: 404 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("InvitePage", () => {
  it("reads #invite= once, clears it from the address bar and keeps it for the tab", () => {
    history.replaceState(null, "", "/#invite=inv_abc");
    expect(takeInviteHash()).toBe("inv_abc");
    expect(location.hash).toBe("");
    expect(takeInviteHash()).toBe("inv_abc"); // a reload before accepting still has it
  });

  it("signs a new person up into the workspace with a name and password", async () => {
    const calls = mockFetch({
      "/invites/inv_abc": () => Response.json(preview()),
      "/providers": () => Response.json(providers),
      "/invites/inv_abc/accept": () => Response.json({ session: "sk_new", expires_at: "", account_id: "acc_1" }),
    });
    const onSession = vi.fn();
    const onDone = vi.fn();
    render(<InvitePage token="inv_abc" authUrl="/api/auth" onSession={onSession} onDone={onDone} />);
    expect(await screen.findByRole("heading", { name: "Join Northwind Ops" })).toBeInTheDocument();
    expect(screen.getByText(/invited as a member/)).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("sam@example.com");
    expect(screen.getByRole("link", { name: "Continue with Google" }).getAttribute("href")).toContain("invite=inv_abc");
    await userEvent.type(screen.getByLabelText("Your name"), "Sam Kim");
    await userEvent.type(screen.getByLabelText("Choose a password"), "a long password");
    await userEvent.click(screen.getByRole("button", { name: "Create account and join" }));
    await waitFor(() => expect(onSession).toHaveBeenCalledWith("sk_new"));
    expect(onDone).toHaveBeenCalled();
    const accept = calls.find((c) => c.url.endsWith("/accept"))!;
    expect(JSON.parse(String(accept.init?.body))).toEqual({ name: "Sam Kim", password: "a long password" });
  });

  it("joins with the current session when someone is signed in, and shows refusals", async () => {
    const calls = mockFetch({
      "/invites/inv_abc": () => Response.json(preview({ existing_user: true, has_password: true })),
      "/providers": () => Response.json(providers),
      "/invites/inv_abc/accept": () => Response.json({ error: { code: "forbidden", message: "This invite was sent to sam@example.com. Sign in with that address to accept it." } }, { status: 403 }),
    });
    render(<InvitePage token="inv_abc" authUrl="/api/auth" apiKey="sk_me" onSession={vi.fn()} onDone={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Accept and join" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This invite was sent to sam@example.com");
    const accept = calls.find((c) => c.url.endsWith("/accept"))!;
    expect((accept.init?.headers as Record<string, string>).authorization).toBe("Bearer sk_me");
  });

  it("explains a used or expired link", async () => {
    mockFetch({
      "/invites/inv_old": () => Response.json({ error: { code: "invite_invalid", message: "This invite has expired. Ask for a new one." } }, { status: 410 }),
      "/providers": () => Response.json(providers),
    });
    const onDone = vi.fn();
    render(<InvitePage token="inv_old" authUrl="/api/auth" onSession={vi.fn()} onDone={onDone} />);
    expect(await screen.findByText("This invite has expired. Ask for a new one.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Go to Senseplane" }));
    expect(onDone).toHaveBeenCalled();
  });
});
