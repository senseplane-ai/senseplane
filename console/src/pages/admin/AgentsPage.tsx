// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Agents (ADR 0047, 0048). Leads with the apps people connected through MCP
// consent (Claude Code, Cursor, …): when each connected and was last active,
// what it can use (edited in place with the consent page's picker), and
// Disconnect, which revokes its keys and so its OAuth tokens. Without apps it
// explains how to connect one, with this instance's MCP URL. API keys for
// scripts and custom code sit in a separate developer section; a key is shown
// once. Everything here is admin work (ADR 0044).
import { useState } from "react";
import type { Grant, Senseplane, Source } from "senseplane";
import { useMcpUrl } from "../../mcp";
import { type Access, AccessPicker, accessComplete, accessOf, defaultPermissions, grantBody, permissionLabels } from "./AccessPicker";
import {
  type PageProps, CodeLine, Confirm, CopyButton, Dialog, ErrorNote, Header, LoadState, can, ctxOf, ago, fmtDate, roleNote, useLoad, useRole, useSources,
} from "./kit";

export { mcpUrl } from "../../mcp";

type Agent = {
  id: string; name: string; kind?: "key" | "app" | "channel"; key_prefix?: string; client_name?: string; redirect_host?: string;
  connected_at?: string; last_active_at?: string | null; created_at: string;
};

/** How to add this instance's MCP server to common clients. The client then opens the consent page. */
export function connectSteps(mcp: string): Record<string, { label: string; how: string; cmd: string }> {
  return {
    "claude-code": { label: "Claude Code", how: "Run this in your terminal, then /mcp in Claude Code to connect:", cmd: `claude mcp add --transport http senseplane ${mcp}` },
    "claude-desktop": { label: "Claude Desktop", how: "Settings → Connectors → Add custom connector, then paste:", cmd: mcp },
    cursor: { label: "Cursor", how: "Add to .cursor/mcp.json, then press Connect next to senseplane:", cmd: `{ "mcpServers": { "senseplane": { "url": "${mcp}" } } }` },
    chatgpt: { label: "ChatGPT", how: "Settings → Connectors → Create, then paste the MCP URL:", cmd: mcp },
    other: { label: "Any MCP client", how: "Add a remote (Streamable HTTP) server with this URL:", cmd: mcp },
  };
}

/** "5 min ago", "just now", "never". */
const since = (iso?: string | null) => { const s = ago(iso); return /^(Never|Just now|Yesterday)$/.test(s) ? s.toLowerCase() : s; };

/** The SDK snippet for the developer section. */
const sdkSnippet = (apiUrl: string) =>
  `npm install senseplane\n\nimport { Senseplane } from "senseplane";\nconst sp = new Senseplane({ apiKey: process.env.SENSEPLANE_KEY, baseUrl: "${new URL(apiUrl, typeof location === "undefined" ? "http://localhost" : location.origin).href.replace(/\/$/, "")}" });`;

export function AgentsPage(p: PageProps) {
  const { role } = useRole(ctxOf(p));
  const editable = can.keys(role);
  const sources = useSources(p);
  const mcp = useMcpUrl(p.apiUrl);
  const data = useLoad(async () => {
    const agents = ((await p.client.agents.list()) as { data: Agent[] }).data;
    const grants: Grant[] = [];
    for await (const g of p.client.grants.list()) grants.push(g);
    return { agents, grants };
  }, [p.apiUrl, p.apiKey]);
  const [revoking, setRevoking] = useState<Agent | null>(null);
  const [creating, setCreating] = useState(false);
  const grantsOf = (id: string) => data.data?.grants.filter((g) => g.agent_id === id) ?? [];
  const remove = (a: Agent) => data.setData((d) => d && { ...d, agents: d.agents.filter((x) => x.id !== a.id) });

  return (
    <div className="adm">
      <Header eyebrow="Agents" title="Connected apps" />
      {!editable && <p className="adm-note">{roleNote[role] || "Only owners and admins can connect apps or change their access."}</p>}

      <LoadState r={data} what="Agents">
        {({ agents }) => {
          // Linked Telegram chats ask as agents of their own (ADR 0059); they sit with the apps.
          const apps = agents.filter((a) => a.kind === "app" || a.kind === "channel");
          const keys = agents.filter((a) => a.kind !== "app" && a.kind !== "channel");
          const card = (a: Agent) => (
            <AgentCard key={a.id} agent={a} grants={grantsOf(a.id)} sources={sources.list} client={p.client} editable={editable}
              onSaved={() => void data.reload()} onRevoke={() => setRevoking(a)} />
          );
          return (
            <>
              <section aria-labelledby="apps-h" className="adm-section">
                <h2 id="apps-h" className="adm-sr">Connected apps</h2>
                {apps.length ? <ul className="adm-apps" aria-label="Connected apps" style={{ listStyle: "none", margin: 0, padding: 0 }}>{apps.map(card)}</ul> : null}
                <ConnectHelp mcp={mcp.url} empty={!apps.length} />
              </section>

              <section aria-labelledby="dev-h" className="adm-section adm-dev">
                <span className="adm-dev-tag">For developers</span>
                <div className="adm-row" style={{ justifyContent: "space-between" }}>
                  <h2 id="dev-h" className="adm-h2">API keys for scripts and custom code</h2>
                  <button type="button" className="adm-btn" style={{ height: 36, padding: "0 14px" }} disabled={!editable} onClick={() => setCreating(true)}>Create API key</button>
                </div>
                <p className="adm-muted adm-small">
                  For the REST API, the SDK, the local (stdio) MCP server with SENSEPLANE_API_KEY, and your own code. Each key sees only the access you give it,
                  and is shown once. Apps like Claude and Cursor don&apos;t need one: connect them with the MCP URL above.
                </p>
                {keys.length ? <ul className="adm-apps" aria-label="API keys" style={{ listStyle: "none", margin: 0, padding: 0 }}>{keys.map(card)}</ul> : <p className="adm-note">No API keys yet.</p>}
                <details className="adm-well" style={{ padding: "10px 14px" }}>
                  <summary className="adm-small adm-muted" style={{ cursor: "pointer" }}>Use a key with the SDK</summary>
                  <div style={{ marginTop: 10 }}><CodeLine code={sdkSnippet(p.apiUrl)} /></div>
                </details>
                <WorkspaceKeys client={p.client} owner={role === "owner"} />
              </section>
            </>
          );
        }}
      </LoadState>

      {creating && <CreateKeyDialog client={p.client} sources={sources.list} onClose={() => { setCreating(false); void data.reload(); }} />}
      {revoking && (
        <Confirm
          title={revoking.kind === "key" || !revoking.kind ? `Delete the key ${revoking.name}?` : `Disconnect ${revoking.name}?`}
          action={revoking.kind === "key" || !revoking.kind ? "Delete key" : "Disconnect"}
          body={revoking.kind === "channel"
            ? <>The chat stops getting alerts and can&apos;t ask any more. To use it again, connect it again from Settings → Notifications.</>
            : revoking.kind === "app"
            ? <>{revoking.name} loses access on its next request, on every device it connected from. To use it again, connect it again from the app.</>
            : <>The key and its access stop working on its next request.</>}
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await p.client.agents.delete(revoking.id);
            remove(revoking);
          }}
        />
      )}
    </div>
  );
}

/** How to connect an app; the empty state when nothing is connected yet. */
function ConnectHelp({ mcp, empty }: { mcp: string; empty: boolean }) {
  const steps = connectSteps(mcp);
  const [client, setClient] = useState("claude-code");
  const cur = steps[client]!;
  return (
    <div className="adm-panel adm-stack" style={{ gap: 14 }} aria-labelledby="connect-h">
      <div className="adm-col" style={{ gap: 4 }}>
        <h3 id="connect-h" className="adm-h2">{empty ? "No apps connected yet" : "Connect another app"}</h3>
        <p className="adm-muted adm-small">
          {empty ? "Give Claude Code, Cursor or any MCP client eyes and ears. " : ""}
          Add Senseplane in the app with this MCP URL. The app opens a Senseplane page where you sign in and choose which cameras and sensors it can use.
        </p>
      </div>
      <CodeLine code={mcp} />
      <div role="tablist" aria-label="App" className="adm-chips">
        {Object.entries(steps).map(([id, s]) => (
          <button key={id} type="button" role="tab" className="adm-chip" aria-selected={client === id} onClick={() => setClient(id)}>{s.label}</button>
        ))}
      </div>
      <div className="adm-col" role="tabpanel" aria-label={cur.label} style={{ gap: 8 }}>
        <span className="adm-muted" style={{ fontSize: 13 }}>{cur.how}</span>
        <CodeLine code={cur.cmd} />
      </div>
    </div>
  );
}

/** One app or key: what it can use, edited in place, and revoke. */
function AgentCard({ agent, grants, sources, client, editable, onSaved, onRevoke }: {
  agent: Agent; grants: Grant[]; sources: Source[]; client: Senseplane; editable: boolean; onSaved: () => void; onRevoke: () => void;
}) {
  const app = agent.kind === "app" || agent.kind === "channel";
  const [editing, setEditing] = useState<Access | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const access = accessOf(grants);
  const window = grants.find((g) => g.window)?.window;
  const ids = access.sources;
  const name = (id: string) => sources.find((s) => s.id === id)?.name ?? id;
  const sees = !ids.length ? "Nothing yet" : sources.length > 1 && sources.every((s) => ids.includes(s.id)) ? "All cameras and sensors" : ids.map(name).join(", ");

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setErr(undefined);
    try {
      if (accessComplete(editing)) {
        await client.grants.create({ agent_id: agent.id, ...grantBody(editing), ...(window ? { window } : {}) } as never);
      }
      for (const g of grants) await client.grants.delete(g.id);
      setEditing(null);
      onSaved();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const meta = agent.kind === "channel"
    ? ["Telegram chat", `Linked ${fmtDate(agent.created_at)}`, `Last asked ${since(agent.last_active_at)}`]
    : app
    ? [`Connected ${fmtDate(agent.connected_at ?? agent.created_at)}`, `Last active ${since(agent.last_active_at)}`, agent.redirect_host ? `via ${agent.redirect_host}` : ""]
    : [agent.key_prefix ? `Key ${agent.key_prefix}…` : "Key", `Created ${fmtDate(agent.created_at)}`, `Last used ${since(agent.last_active_at)}`];
  return (
    <li className="adm-card adm-app" aria-label={agent.name}>
      <div className="adm-app-top">
        <div className="adm-col" style={{ gap: 2 }}>
          <span className="adm-app-name">{agent.name}</span>
          <span className="adm-app-meta">{meta.filter(Boolean).join(" · ")}</span>
        </div>
        <div className="adm-app-actions">
          {!editing && (
            <button type="button" className="adm-btn adm-btn-sm adm-btn-ghost" disabled={!editable} aria-label={`Edit access for ${agent.name}`}
              onClick={() => setEditing(grants.length ? access : { sources: [], permissions: defaultPermissions })}>Edit access</button>
          )}
          <button type="button" className="adm-btn adm-btn-sm adm-btn-danger" disabled={!editable} onClick={onRevoke}
            aria-label={app ? `Disconnect ${agent.name}` : `Delete key ${agent.name}`}>{app ? "Disconnect" : "Delete"}</button>
        </div>
      </div>
      {!editing ? (
        <div className="adm-app-access">
          <span><span className="adm-muted">Can see:</span> {sees}</span>
          {grants.length > 0 ? (
            <span className="adm-row">
              {permissionLabels(access).map((l) => <span key={l} className="adm-pill">{l}</span>)}
              {window && <span className="adm-pill">{`only ${window.from ? `from ${fmtDate(window.from)}` : ""}${window.to ? ` to ${fmtDate(window.to)}` : ""}`.trim()}</span>}
            </span>
          ) : <span className="adm-muted">No access: it can&apos;t see anything.</span>}
        </div>
      ) : (
        <div className="adm-app-edit">
          <AccessPicker sources={sources} value={editing} onChange={setEditing} idPrefix={`edit-${agent.id}`} />
          {!accessComplete(editing) && <p className="adm-warn-note adm-small">Saved like this, {agent.name} keeps its {app ? "connection" : "key"} but can&apos;t see anything.</p>}
          <ErrorNote error={err} />
          <div className="adm-row">
            <button type="button" className="adm-btn adm-btn-primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save access"}</button>
            <button type="button" className="adm-btn" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Create an API key (an agent with one grant); the key is shown once. */
type WorkspaceKey = { id: string; name: string; key_prefix: string; created_at: string; last_used_at: string | null };

/**
 * Full-access keys for a developer's own apps and scripts: adding cameras, managing watches and webhooks.
 * They act above every role, so only owners make or revoke them; admins see the list.
 */
function WorkspaceKeys({ client, owner }: { client: Senseplane; owner: boolean }) {
  const keys = useLoad(() => client.keys.list() as Promise<WorkspaceKey[]>, [client]);
  const [name, setName] = useState("");
  const [making, setMaking] = useState(false);
  const [shown, setShown] = useState("");
  const [revoking, setRevoking] = useState<WorkspaceKey | null>(null);
  const [err, setErr] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const k = (await client.keys.create(name.trim())) as WorkspaceKey & { api_key: string };
      setShown(k.api_key);
      keys.setData((l) => [...(l ?? []), k]);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  if (keys.missing) return null;
  return (
    <div className="adm-stack" style={{ gap: 8 }}>
      <div className="adm-row" style={{ justifyContent: "space-between" }}>
        <h3 className="adm-h2" style={{ fontSize: 14 }}>Workspace keys</h3>
        <button type="button" className="adm-btn" style={{ height: 32, padding: "0 12px" }} disabled={!owner} onClick={() => { setMaking(true); setName(""); setShown(""); }}>Create workspace key</button>
      </div>
      <p className="adm-muted adm-small">
        Full access to this workspace, for your own apps and scripts: adding cameras, watches, webhooks and Telegram chats. Never give one to an AI agent; give agents an API key above.
        {!owner && " Only owners can create or revoke them."}
      </p>
      <LoadState r={keys} what="Workspace keys">
        {(list) => list.length ? (
          <ul className="adm-apps" aria-label="Workspace keys" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {list.map((k) => (
              <li key={k.id} className="adm-card adm-app" aria-label={k.name}>
                <div className="adm-app-top">
                  <div className="adm-col" style={{ gap: 2 }}>
                    <span className="adm-app-name">{k.name}</span>
                    <span className="adm-app-meta">{[`Key ${k.key_prefix}…`, `Created ${fmtDate(k.created_at)}`, `Last used ${since(k.last_used_at)}`].join(" · ")}</span>
                  </div>
                  <div className="adm-app-actions">
                    <button type="button" className="adm-btn adm-btn-sm adm-btn-danger" disabled={!owner} aria-label={`Revoke workspace key ${k.name}`} onClick={() => setRevoking(k)}>Revoke</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="adm-note">No workspace keys yet.</p>}
      </LoadState>
      {making && (
        <Dialog title={shown ? "Your new workspace key" : "Create a workspace key"} onClose={() => setMaking(false)}>
          {shown ? (
            <>
              <div className="adm-secret" role="status">
                <span>Copy it now. It is shown only once.</span>
                <div className="adm-code"><code>{shown}</code><CopyButton text={shown} /></div>
              </div>
              <p className="adm-muted adm-small">Send it as a Bearer token from your code. Anyone with it can do anything in this workspace; keep it secret.</p>
              <div className="adm-dialog-foot"><button type="button" className="adm-btn adm-btn-primary" onClick={() => setMaking(false)}>Done</button></div>
            </>
          ) : (
            <>
              <label className="adm-field">
                <span className="adm-small adm-muted">Name</span>
                <input className="adm-input adm-input-dark adm-input-lg" value={name} maxLength={120} placeholder="My app" onChange={(e) => setName(e.target.value)} />
              </label>
              <p className="adm-muted adm-small">This key can add and delete cameras and change everything in the workspace, above any team role.</p>
              <ErrorNote error={err} />
              <div className="adm-dialog-foot">
                <button type="button" className="adm-btn" onClick={() => setMaking(false)}>Cancel</button>
                <button type="button" className="adm-btn adm-btn-primary" disabled={!name.trim() || busy} onClick={() => void create()}>{busy ? "Creating…" : "Create key"}</button>
              </div>
            </>
          )}
        </Dialog>
      )}
      {revoking && (
        <Confirm title={`Revoke ${revoking.name}?`} action="Revoke" body="Apps and scripts using it stop working on their next request." onClose={() => setRevoking(null)}
          onConfirm={async () => { await client.keys.delete(revoking.id); keys.setData((l) => l?.filter((x) => x.id !== revoking.id)); }} />
      )}
    </div>
  );
}

function CreateKeyDialog({ client, sources, onClose }: { client: Senseplane; sources: Source[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [access, setAccess] = useState<Access>({ sources: [], permissions: ["look"] });
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [key, setKey] = useState("");

  const create = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const created = await client.agents.create({ name: name.trim() });
      if (accessComplete(access)) {
        const window = from || to ? { ...(from ? { from: new Date(from).toISOString() } : {}), ...(to ? { to: new Date(to).toISOString() } : {}) } : undefined;
        await client.grants.create({ agent_id: created.id, ...grantBody(access), ...(window ? { window } : {}) } as never);
      }
      setKey(created.api_key);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  if (key) {
    return (
      <Dialog title="Your new API key" onClose={onClose}>
        <div className="adm-secret" role="status">
          <span>Copy it now. It is shown only once.</span>
          <div className="adm-code"><code>{key}</code><CopyButton text={key} /></div>
        </div>
        <p className="adm-muted adm-small">Send it as a Bearer token from your code, or set it as SENSEPLANE_API_KEY for the local MCP server.</p>
        <div className="adm-dialog-foot"><button type="button" className="adm-btn adm-btn-primary" onClick={onClose}>Done</button></div>
      </Dialog>
    );
  }
  return (
    <Dialog title="Create an API key" onClose={onClose} wide>
      <label className="adm-field">
        <span className="adm-small adm-muted">Name</span>
        <input className="adm-input adm-input-dark adm-input-lg" value={name} maxLength={120} placeholder="ops-bot production" onChange={(e) => setName(e.target.value)} />
      </label>
      <AccessPicker sources={sources} value={access} onChange={setAccess} idPrefix="new-key" />
      <fieldset className="adm-fieldset">
        <legend className="adm-legend">Only between (optional)</legend>
        <div className="adm-row">
          <label className="adm-label">From<input className="adm-input adm-input-dark" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="adm-label">To<input className="adm-input adm-input-dark" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      </fieldset>
      <p className="adm-note">You&apos;ll see the key once, right after you create it.</p>
      <ErrorNote error={err} />
      <div className="adm-dialog-foot">
        <button type="button" className="adm-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="adm-btn adm-btn-primary" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? "Creating…" : "Create key"}</button>
      </div>
    </Dialog>
  );
}
