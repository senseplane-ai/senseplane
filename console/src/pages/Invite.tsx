// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Accepting an invite link (`<console>/#invite=<token>`, ADR 0044): shows the
// workspace and role, then joins it with the current session, the invited
// address's password, a new password (sign-up, open even when sign-up is
// closed), or Google/GitHub.
import { type FormEvent, useEffect, useState } from "react";
import { deviceToken } from "../session";
import { Button, Field, Input, Logo } from "../ui";
import { MIN_PASSWORD, type Providers } from "./SignIn";
import "./signin.css";

interface InvitePreview {
  workspace: { name: string };
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
  expires_at: string;
  existing_user: boolean;
  has_password: boolean;
}

const ROLE: Record<InvitePreview["role"], string> = {
  owner: "an owner", admin: "an admin", member: "a member", viewer: "a viewer",
};

export function InvitePage({ token, authUrl, apiKey, onSession, onDone }: {
  token: string;
  authUrl: string;
  /** The current console session, if someone is signed in. */
  apiKey?: string;
  onSession: (key: string) => void;
  /** Leaves the invite (accepted, invalid, or declined). */
  onDone: () => void;
}) {
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  const [invalid, setInvalid] = useState("");
  const [providers, setProviders] = useState<Providers | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "Join a workspace · Senseplane";
    let live = true;
    fetch(`${authUrl}/invites/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!live) return;
        if (r.ok) setInvite(body as InvitePreview);
        else setInvalid(body?.error?.message ?? "This invite link isn't valid.");
      })
      .catch(() => live && setInvalid("Can't reach the server. Check your connection and try again."));
    fetch(`${authUrl}/providers`).then((r) => (r.ok ? r.json() : null)).then((p) => live && setProviders(p)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [authUrl, token]);

  async function accept(body: Record<string, string>, session?: string) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${authUrl}/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) },
        body: JSON.stringify(body),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out?.error?.message ?? "Couldn't accept the invite.");
      onSession(out.session);
      onDone();
    } catch (err) {
      setError(err instanceof TypeError ? "Can't reach the server. Check your connection and try again." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = f.get("name")?.toString().trim();
    void accept({ password: f.get("password")?.toString() ?? "", ...(name ? { name } : {}) });
  };

  const oauth = (p: "google" | "github") =>
    `${authUrl}/oauth/${p}/start?${new URLSearchParams({ return_to: location.origin, device_token: deviceToken(), invite: token })}`;
  const isNew = invite ? !invite.existing_user : false;

  return (
    <div className="signin">
      <main className="signin-main">
        <div className="signin-col">
          <Logo size={24} />
          {!invite && !invalid && <p className="muted" role="status">Checking your invite…</p>}
          {invalid && (
            <>
              <div className="signin-head">
                <h1>This invite can&apos;t be used</h1>
                <p className="muted">{invalid}</p>
              </div>
              <Button variant="primary" size="lg" onClick={onDone}>Go to Senseplane</Button>
            </>
          )}
          {invite && (
            <>
              <div className="signin-head">
                <h1>Join {invite.workspace.name}</h1>
                <p className="muted">
                  You&apos;re invited as {ROLE[invite.role]}, as <strong>{invite.email}</strong>.
                </p>
              </div>
              {error && <p role="alert" className="notice notice-error">{error}</p>}
              {apiKey ? (
                <div className="signin-form">
                  <Button variant="primary" size="lg" busy={busy} onClick={() => void accept({}, apiKey)}>Accept and join</Button>
                  <p className="field-hint">You&apos;re signed in. Joining adds {invite.workspace.name} to your workspaces and opens it.</p>
                  <button type="button" className="link-btn" onClick={onDone}>Not now</button>
                </div>
              ) : (
                <>
                  {(providers?.google || providers?.github) && (
                    <div className="signin-oauth">
                      {providers.google && <a className="btn btn-secondary btn-lg" href={oauth("google")}>Continue with Google</a>}
                      {providers.github && <a className="btn btn-secondary btn-lg" href={oauth("github")}>Continue with GitHub</a>}
                    </div>
                  )}
                  {providers?.password !== false && (
                    <form className="signin-form" onSubmit={submit}>
                      <Field label="Email">
                        <Input name="email" type="email" value={invite.email} readOnly size="lg" autoComplete="username" />
                      </Field>
                      {isNew && (
                        <Field label="Your name">
                          <Input name="name" autoComplete="name" size="lg" placeholder="Sam Kim" />
                        </Field>
                      )}
                      <Field label={isNew ? "Choose a password" : "Password"} hint={isNew ? `At least ${MIN_PASSWORD} characters.` : undefined}>
                        <Input
                          name="password" type="password" size="lg" required placeholder="••••••••••"
                          minLength={isNew ? MIN_PASSWORD : undefined} autoComplete={isNew ? "new-password" : "current-password"}
                        />
                      </Field>
                      <Button type="submit" variant="primary" size="lg" busy={busy}>{isNew ? "Create account and join" : "Sign in and join"}</Button>
                    </form>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
