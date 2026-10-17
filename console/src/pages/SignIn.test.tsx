// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignInPage } from "./SignIn";

const providers = (over: object = {}) => ({ password: true, google: false, github: false, signup: false, challenge: null, ...over });

function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.endsWith(k) || url.includes(`${k}?`));
    return key ? routes[key]!(init) : new Response("{}", { status: 404 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const page = (onSession = vi.fn()) => render(<SignInPage authUrl="/api/auth" onSession={onSession} />);

describe("SignInPage", () => {
  it("shows only email sign-in when no OAuth providers or sign-up are configured", async () => {
    mockFetch({ "/providers": () => Response.json(providers()) });
    page();
    expect(await screen.findByLabelText("Work email")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("Continue with Google")).toBeNull();
    expect(screen.queryByText("Continue with GitHub")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create an account" })).toBeNull();
    expect(screen.queryByText("Forgot password?")).toBeNull();
    expect(screen.getByText("Lawful use")).toHaveAttribute("href", "https://docs.senseplane.com/lawful-use");
  });

  it("shows Google and GitHub when enabled, with links to the OAuth start routes", async () => {
    mockFetch({ "/providers": () => Response.json(providers({ google: true, github: true })) });
    page();
    const google = await screen.findByRole("link", { name: "Continue with Google" });
    expect(google.getAttribute("href")).toMatch(/^\/api\/auth\/oauth\/google\/start\?return_to=/);
    expect(screen.getByRole("link", { name: "Continue with GitHub" })).toBeInTheDocument();
  });

  it("signs in with email and password and hands back the session", async () => {
    const calls = mockFetch({
      "/providers": () => Response.json(providers()),
      "/login": () => Response.json({ session: "sk_session" }),
    });
    const onSession = vi.fn();
    page(onSession);
    await userEvent.type(await screen.findByLabelText("Work email"), "alex@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "correct horse battery");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onSession).toHaveBeenCalledWith("sk_session"));
    const login = calls.find((c) => c.url.endsWith("/login"))!;
    expect(JSON.parse(String(login.init!.body))).toMatchObject({ email: "alex@example.com", password: "correct horse battery" });
  });

  it("shows the API's error message", async () => {
    mockFetch({
      "/providers": () => Response.json(providers()),
      "/login": () => Response.json({ error: { code: "unauthorized", message: "Wrong email or password." } }, { status: 401 }),
    });
    page();
    await userEvent.type(await screen.findByLabelText("Work email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong email or password.");
  });

  it("switches to sign-up when the instance allows it", async () => {
    const calls = mockFetch({
      "/providers": () => Response.json(providers({ signup: true })),
      "/signup": () => Response.json({ session: "sk_new" }, { status: 201 }),
    });
    const onSession = vi.fn();
    page(onSession);
    await userEvent.click(await screen.findByRole("button", { name: "Create an account" }));
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeInTheDocument();
    expect(screen.getByText("At least 10 characters.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Work email"), "new@example.com");
    await userEvent.type(screen.getByLabelText(/^Password/), "a long password");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(onSession).toHaveBeenCalledWith("sk_new"));
    expect(calls.some((c) => c.url.endsWith("/signup"))).toBe(true);
  });

  it("never offers to sign in with an API key", async () => {
    mockFetch({ "/providers": () => Response.json(providers()) });
    page();
    await screen.findByLabelText("Work email");
    expect(screen.queryByText(/API key/i)).toBeNull();
    expect(screen.queryByPlaceholderText("sk_…")).toBeNull();
    expect(document.querySelector("details")).toBeNull();
  });

  it("points to an invite when sign-up is closed", async () => {
    mockFetch({ "/providers": () => Response.json(providers({ signup: false })) });
    page();
    expect(await screen.findByText("No account yet? Ask an admin of your workspace for an invite link.")).toBeInTheDocument();
  });

  it("says so when the instance has no sign-in method", async () => {
    mockFetch({ "/providers": () => Response.json(providers({ password: false })) });
    page();
    expect(await screen.findByRole("alert")).toHaveTextContent("no sign-in method");
    expect(screen.queryByLabelText("Work email")).toBeNull();
  });

  it("takes a heading and context for the consent page", async () => {
    mockFetch({ "/providers": () => Response.json(providers()) });
    render(<SignInPage authUrl="/api/auth" onSession={vi.fn()} heading="Sign in to connect Claude Code" context={<p>where it goes</p>} />);
    expect(await screen.findByRole("heading", { name: "Sign in to connect Claude Code" })).toBeInTheDocument();
    expect(screen.getByText("where it goes")).toBeInTheDocument();
  });
});
