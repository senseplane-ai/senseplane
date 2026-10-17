// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Sign in (ADR 0031, 0046, 0048): email and password, Google and GitHub only
// when the instance configures them, and sign-up when it's open. API keys are
// for code (REST, SDK, stdio MCP), never a way into the console.
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { deviceToken } from "../session";
import { Button, Field, Frame, Input, Logo } from "../ui";
import "./signin.css";

export interface Providers {
  password: boolean;
  google: boolean;
  github: boolean;
  signup: boolean;
  /** Present when the instance offers password reset. */
  password_reset?: boolean;
  challenge: { provider: string; site_key: string } | null;
  /** This instance's public MCP base URL, when the API knows it (ADR 0048). */
  mcp_url?: string | null;
}

/** The API's minimum for new passwords (spec/auth). */
export const MIN_PASSWORD = 10;

const GOOGLE = "M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3zM12 22c2.7 0 5-.9 6.6-2.5l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22zM6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9zM12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6z";
const GITHUB = "M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 2.9.8.1-.6.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z";

export function SignInPage({ authUrl, onSession, initialError, heading, intro, context }: {
  authUrl: string; onSession: (key: string) => void; initialError?: string;
  /** Overrides for the consent page, which signs people in on the way (ADR 0048). */
  heading?: string; intro?: ReactNode; context?: ReactNode;
}) {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState(initialError ?? "");
  const [busy, setBusy] = useState(false);
  const [challengeToken, setChallengeToken] = useState("");
  const up = mode === "signup";

  useEffect(() => {
    fetch(`${authUrl}/providers`).then((r) => (r.ok ? r.json() : null)).then(setProviders).catch(() => setProviders(null));
  }, [authUrl]);

  useEffect(() => {
    if (!heading) document.title = up ? "Create your account · Senseplane" : "Sign in · Senseplane";
  }, [up, heading]);

  // Optional sign-up challenge widget (e.g. Turnstile), only when the instance configures one.
  useEffect(() => {
    const c = providers?.challenge;
    if (!c || c.provider !== "turnstile" || !up) return;
    const w = window as unknown as { onSenseplaneChallenge?: (t: string) => void };
    w.onSenseplaneChallenge = setChallengeToken;
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    s.async = true;
    document.head.appendChild(s);
    return () => s.remove();
  }, [providers, up]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${authUrl}/${up ? "signup" : "login"}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: f.get("email"), password: f.get("password"), device_token: deviceToken(),
          ...(challengeToken ? { challenge_token: challengeToken } : {}),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error?.message ?? (up ? "Could not create the account." : "Sign-in failed."));
      onSession(body.session);
    } catch (err) {
      setError(err instanceof TypeError ? "Can't reach the server. Check your connection and try again." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const oauth = (p: "google" | "github") =>
    `${authUrl}/oauth/${p}/start?${new URLSearchParams({ return_to: location.origin, device_token: deviceToken() })}`;
  const passwordOn = providers?.password !== false;
  const anyOauth = !!(providers?.google || providers?.github);

  return (
    <div className="signin">
      <main className="signin-main">
        <div className="signin-col">
          <Logo size={24} />
          <div className="signin-head">
            <h1>{heading ?? (up ? "Create your account" : "Sign in")}</h1>
            <p className="muted">{intro ?? (up ? "Give your agents eyes and ears in a few minutes." : "Welcome back. Your cameras kept watching.")}</p>
          </div>
          {context}

          {error && <p role="alert" className="notice notice-error">{error}</p>}

          {anyOauth && (
            <div className="signin-oauth">
              {providers?.google && (
                <a className="btn btn-secondary btn-lg" href={oauth("google")}>
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={GOOGLE} /></svg>
                  Continue with Google
                </a>
              )}
              {providers?.github && (
                <a className="btn btn-secondary btn-lg" href={oauth("github")}>
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={GITHUB} /></svg>
                  Continue with GitHub
                </a>
              )}
            </div>
          )}
          {anyOauth && passwordOn && <div className="signin-or" aria-hidden="true"><span />OR WITH EMAIL<span /></div>}

          {passwordOn && (
            <form className="signin-form" onSubmit={submit}>
              <Field label="Work email">
                <Input name="email" type="email" autoComplete="email" placeholder="you@company.com" required size="lg" />
              </Field>
              <Field
                label="Password"
                hint={up ? `At least ${MIN_PASSWORD} characters.` : undefined}
                labelAction={!up && providers?.password_reset ? <a href="/reset-password" className="signin-forgot">Forgot password?</a> : undefined}
              >
                <Input
                  name="password" type="password" size="lg" placeholder="••••••••••" required
                  minLength={up ? MIN_PASSWORD : undefined} autoComplete={up ? "new-password" : "current-password"}
                />
              </Field>
              {up && providers?.challenge?.provider === "turnstile" && (
                <div className="cf-turnstile" data-sitekey={providers.challenge.site_key} data-callback="onSenseplaneChallenge" />
              )}
              <Button type="submit" variant="primary" size="lg" busy={busy}>{up ? "Create account" : "Sign in"}</Button>
            </form>
          )}

          {providers && !passwordOn && !anyOauth && (
            <p role="alert" className="notice notice-error">This instance has no sign-in method turned on. Its operator can turn on email sign-in (AUTH_PASSWORD) or Google or GitHub.</p>
          )}

          {providers?.signup ? (
            <p className="signin-switch muted">
              {up ? "Already have an account?" : "New to Senseplane?"}{" "}
              <button type="button" className="link-btn" onClick={() => { setMode(up ? "signin" : "signup"); setError(""); }}>
                {up ? "Sign in" : "Create an account"}
              </button>
            </p>
          ) : providers ? (
            <p className="signin-switch muted">No account yet? Ask an admin of your workspace for an invite link.</p>
          ) : null}
        </div>
        <p className="signin-legal">
          By continuing you agree to point cameras only where you are allowed to.{" "}
          <a href="https://docs.senseplane.com/lawful-use" target="_blank" rel="noreferrer">Lawful use</a>
        </p>
      </main>

      <aside className="signin-aside" aria-hidden="true">
        <div className="signin-aside-col">
          <Frame alt="" className="signin-frame">
            <div className="detection" style={{ left: "40%", top: "24%", width: "15%", height: "56%" }}><span>person 0.94</span></div>
            <span className="frame-label tl signin-watching"><span className="dot dot-live" style={{ width: 6, height: 6 }} />FRONT DOOR · WATCHING</span>
          </Frame>
          <div className="signin-transcript">
            <span className="dim">you → agent</span>
            <span>Tell me when a parcel is left at the front door.</span>
            <span className="dim" style={{ marginTop: 6 }}>agent → watch_for()</span>
            <span className="live-text">Watching Front door for a parcel. I&apos;ll message you.</span>
          </div>
          <p className="muted signin-tagline">Eyes and ears for your AI agents: real video, not just labels.</p>
        </div>
      </aside>
    </div>
  );
}
