// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The MCP consent page (`/connect#request=…`, ADR 0048). An MCP client's
// Connect button lands here through the MCP service's /oauth/authorize. The
// page shows which app is asking and where access goes (with the "not
// verified" warning), signs the person in if needed (or borrows another open
// console tab's session), lets an admin pick cameras, sensors and permissions,
// and on Allow asks the API for a connect code that it posts to the MCP
// service, which finishes the OAuth flow. The browser never sees a key.
import { useEffect, useMemo, useState } from "react";
import { Senseplane, type Grant, type Source } from "senseplane";
import { mcpBase, useMcpUrl } from "../mcp";
import { borrowSession, forgetConnect } from "../session";
import { Button, Logo } from "../ui";
import { type Access, AccessPicker, accessComplete, accessOf, defaultPermissions, grantBody } from "./admin/AccessPicker";
import { SignInPage } from "./SignIn";
import "./signin.css";

interface RequestInfo {
  client_name: string;
  redirect_host: string;
  verified: boolean;
  binding: string;
  expires_at: string;
}
type Agent = { id: string; name: string; kind?: string; client_name?: string; redirect_host?: string };
type Me = { user: { email: string } | null; role: "owner" | "admin" | "member" | "viewer"; account: { name: string } };

/** Same as the API's appHost: no port, loopback as localhost. */
export function appHost(host: string): string {
  const h = host.trim().toLowerCase();
  const bare = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.replace(/:\d+$/, "");
  return ["localhost", "127.0.0.1", "[::1]"].includes(bare) ? "localhost" : bare;
}

/** A top-level form post to the MCP service (a navigation, so no CORS and nothing in its URL logs). */
export function postForm(action: string, fields: Record<string, string>) {
  const f = document.createElement("form");
  f.method = "post";
  f.action = action;
  for (const [name, value] of Object.entries(fields)) {
    const i = document.createElement("input");
    i.type = "hidden";
    i.name = name;
    i.value = value;
    f.appendChild(i);
  }
  document.body.appendChild(f);
  f.submit();
}

export function ConnectPage({ request, apiUrl, authUrl, apiKey, notice, onSession, onSignOut, onDone, post: submit = postForm }: {
  /** A sign-in error to show (e.g. a cancelled Google sign-in). */
  notice?: string;
  /** The sealed request from the MCP service. */
  request: string;
  apiUrl: string;
  authUrl: string;
  /** The current console session, if any. */
  apiKey?: string;
  onSession: (key: string) => void;
  /** Forgets the session in this tab (without ending it: it may be another tab's). */
  onSignOut: () => void;
  /** Leaves the consent page for the console. */
  onDone: () => void;
  /** Submits the decision to the MCP service (tests replace it). */
  post?: (action: string, fields: Record<string, string>) => void;
}) {
  const mcp = useMcpUrl(apiUrl, authUrl);
  const base = mcpBase(mcp.url);
  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [expired, setExpired] = useState("");
  const [borrowing, setBorrowing] = useState(!apiKey);
  // After "Use another account", don't borrow the same session back.
  const [declined, setDeclined] = useState(false);
  const switchAccount = () => {
    setDeclined(true);
    onSignOut();
  };

  useEffect(() => {
    document.title = "Connect an app · Senseplane";
  }, []);

  useEffect(() => {
    if (!mcp.ready) return;
    let live = true;
    fetch(`${base}/oauth/request?${new URLSearchParams({ request })}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!live) return;
        if (r.ok) setInfo(body as RequestInfo);
        else setExpired(body?.error_description ?? "This connection request expired. Go back to your app and connect again.");
      })
      .catch(() => live && setExpired("Can't reach Senseplane's MCP service. Check your connection, then connect again from your app."));
    return () => {
      live = false;
    };
  }, [base, request, mcp.ready]);

  // No session in this tab: borrow one from another signed-in console tab before asking to sign in.
  useEffect(() => {
    if (apiKey) return;
    if (declined) return setBorrowing(false);
    let live = true;
    void borrowSession().then((key) => {
      if (!live) return;
      if (key) onSession(key);
      setBorrowing(false);
    });
    return () => {
      live = false;
    };
  }, [apiKey, onSession, declined]);

  // The decision ends the request in this tab: coming back to the console later opens the console, not this page.
  const post = (action: string, fields: Record<string, string>) => {
    forgetConnect();
    submit(action, fields);
  };
  const deny = () => post(`${base}/oauth/deny`, { request });

  if (expired) {
    return (
      <Frame>
        <div className="signin-head">
          <h1>This request can&apos;t be used</h1>
          <p className="muted">{expired}</p>
        </div>
        <Button variant="primary" size="lg" onClick={onDone}>Go to Senseplane</Button>
      </Frame>
    );
  }
  if (!info || (borrowing && !apiKey)) {
    return <Frame><p className="muted" role="status">Checking the request…</p></Frame>;
  }

  const head = <AppHeader info={info} />;
  if (!apiKey) {
    return (
      <SignInPage
        authUrl={authUrl} onSession={onSession} initialError={notice}
        heading={`Sign in to connect ${info.client_name}`}
        intro={<>Sign in to Senseplane to choose what <strong>{info.client_name}</strong> can use.</>}
        context={<>{head}<button type="button" className="link-btn consent-cancel" onClick={deny}>Cancel and go back</button></>}
      />
    );
  }
  return <Consent key={apiKey} info={info} request={request} apiUrl={apiUrl} apiKey={apiKey} base={base} post={post} onDeny={deny} onSignOut={switchAccount} onExpired={switchAccount} />;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="signin">
      <main className="signin-main">
        <div className="signin-col">
          <Logo size={24} />
          {children}
        </div>
      </main>
    </div>
  );
}

/** Which app is asking and where its access goes; unverified hosts get a warning. */
function AppHeader({ info }: { info: RequestInfo }) {
  return (
    <div className="consent-app">
      <p className="consent-host">
        After you allow it, access is sent to <code>{info.redirect_host}</code>
        {info.verified ? <span className="consent-verified"> (verified)</span> : null}.
      </p>
      {!info.verified && (
        <p className="notice notice-warn consent-warn">
          This app is not verified. The name <strong>{info.client_name}</strong> is chosen by the app itself. Only continue if you
          started this connection yourself and recognise <code>{info.redirect_host}</code>.
        </p>
      )}
    </div>
  );
}

function Consent({ info, request, apiUrl, apiKey, base, post, onDeny, onSignOut, onExpired }: {
  info: RequestInfo; request: string; apiUrl: string; apiKey: string; base: string;
  post: (action: string, fields: Record<string, string>) => void; onDeny: () => void; onSignOut: () => void; onExpired: () => void;
}) {
  const client = useMemo(() => new Senseplane({ apiKey, baseUrl: apiUrl }), [apiKey, apiUrl]);
  const [state, setState] = useState<{ me: Me; sources: Source[]; existing?: Agent; grants: Grant[] } | null>(null);
  const [loadError, setLoadError] = useState("");
  const [access, setAccess] = useState<Access | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    (async () => {
      const auth = { headers: { authorization: `Bearer ${apiKey}` } };
      const meRes = await fetch(`${apiUrl}/me`, auth);
      if (meRes.status === 401) return onExpired();
      const me = (await meRes.json()) as Me;
      const sources: Source[] = [];
      for await (const s of client.sources.list()) sources.push(s);
      let existing: Agent | undefined;
      let grants: Grant[] = [];
      if (me.role === "owner" || me.role === "admin") {
        const agents = ((await client.agents.list()) as { data: Agent[] }).data;
        existing = agents.find((a) => a.kind === "app" && a.client_name === info.client_name && a.redirect_host === appHost(info.redirect_host));
        if (existing) for await (const g of client.grants.list()) if (g.agent_id === existing.id) grants.push(g);
      }
      if (!live) return;
      setState({ me, sources, existing, grants });
      setAccess(existing && grants.length ? accessOf(grants) : { sources: sources.map((s) => s.id), permissions: defaultPermissions });
    })().catch(() => live && setLoadError("Couldn't load your workspace. Reload the page to try again."));
    return () => {
      live = false;
    };
  }, [client, apiUrl, apiKey, info.client_name, info.redirect_host, onExpired]);

  async function allow() {
    if (!access) return;
    setBusy(true);
    setError("");
    try {
      const r = await client.agents.connect({ client_name: info.client_name, redirect_host: info.redirect_host, binding: info.binding, ...grantBody(access) });
      post(`${base}/oauth/approve`, { request, code: r.code });
    } catch (e) {
      setError((e as Error).message || "Couldn't connect the app. Try again.");
      setBusy(false);
    }
  }

  const admin = state && (state.me.role === "owner" || state.me.role === "admin");
  return (
    <Frame>
      <div className="signin-head">
        <h1>{info.client_name} wants to use your cameras</h1>
        <p className="muted">
          {state ? <>Signed in as {state.me.user?.email ?? "an API key"} in <strong>{state.me.account.name}</strong>. </> : null}
          <button type="button" className="link-btn" onClick={onSignOut}>Use another account</button>
        </p>
      </div>
      <AppHeader info={info} />
      {loadError && <p role="alert" className="notice notice-error">{loadError}</p>}
      {!state && !loadError && <p className="muted" role="status">Loading your cameras…</p>}
      {state && !admin && (
        <p role="alert" className="notice notice-warn">
          Only admins and owners of {state.me.account.name} can connect apps. Ask an admin to connect {info.client_name}, or to make you an admin.
        </p>
      )}
      {state && admin && access && (
        <div className="adm consent-picker">
          {state.existing && (
            <p className="adm-note">{info.client_name} is already connected. Allowing replaces its access with what you choose here; its other connections keep working.</p>
          )}
          <AccessPicker sources={state.sources} value={access} onChange={setAccess} idPrefix="connect" />
        </div>
      )}
      {error && <p role="alert" className="notice notice-error">{error}</p>}
      <div className="consent-actions">
        {admin && <Button variant="primary" size="lg" busy={busy} disabled={!access || !accessComplete(access)} onClick={() => void allow()}>Allow</Button>}
        <Button variant="secondary" size="lg" disabled={busy} onClick={onDeny}>Cancel</Button>
      </div>
      <p className="field-hint">You can change what {info.client_name} can use, or disconnect it, at any time under Agents.</p>
    </Frame>
  );
}
