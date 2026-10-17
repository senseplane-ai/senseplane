// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Settings: workspace name and time zone, recording defaults, team and
// invites, sign-in methods (read-only, from the server's auth config), the
// audit log, and export / delete of everything.
import { useEffect, useMemo, useState } from "react";
import type { Senseplane } from "senseplane";
import {
  type AccountX, type AuditEntry, type Invite, type Member, type Role, api, createInvite, errorText, getAccount,
  getAuthProviders, listInvites, listMembers, patchAccount, removeMember, revokeInvite, unavailable, updateMember,
} from "./api";
import {
  type PageProps, Confirm, CopyButton, Dialog, ErrorNote, LoadState, Unavailable, can, ctxOf, dayLabel, fmtDate, fmtHm,
  roleNote, useInterval, useLoad, useRole, useSources,
} from "./kit";

type Tab = "general" | "rec" | "team" | "signin" | "audit" | "data";
const TABS: [Tab, string][] = [["general", "Workspace"], ["rec", "Recording defaults"], ["team", "Team"], ["signin", "Sign-in"], ["audit", "Audit log"], ["data", "Your data"]];
const ROLES: Role[] = ["admin", "member", "viewer"];
const roleName = (r: Role) => r[0]!.toUpperCase() + r.slice(1);

export function SettingsPage(p: PageProps) {
  const ctx = ctxOf(p);
  const { role } = useRole(ctx);
  const account = useLoad(() => getAccount(ctx), [p.apiUrl, p.apiKey]);
  const [tab, setTab] = useState<Tab>("general");
  const refs: (HTMLButtonElement | null)[] = [];
  const key = (e: React.KeyboardEvent, i: number) => {
    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + TABS.length) % TABS.length;
    setTab(TABS[j]![0]);
    refs[j]?.focus();
  };

  return (
    <div className="adm">
      <header className="adm-head-text">
        <span className="adm-eyebrow">Settings</span>
        <h1 className="adm-h1">{account.data?.name ?? "Settings"}</h1>
      </header>
      <div className="adm-settings">
        <div role="tablist" aria-label="Settings sections" aria-orientation="vertical" className="adm-settings-nav">
          {TABS.map(([id, label], i) => (
            <button key={id} ref={(el) => { refs[i] = el; }} id={`set-tab-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`set-panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(e) => key(e, i)}>{label}</button>
          ))}
        </div>
        <div className="adm-settings-body" role="tabpanel" id={`set-panel-${tab}`} aria-labelledby={`set-tab-${tab}`}>
          {!can.settings(role) && tab !== "audit" && tab !== "signin" && <p className="adm-note">{roleNote[role]}</p>}
          {tab === "general" && <LoadState r={account} what="Workspace settings">{(a) => <Workspace p={p} a={a} editable={can.settings(role)} onSaved={(x) => account.setData(() => x)} />}</LoadState>}
          {tab === "rec" && <LoadState r={account} what="Recording defaults">{(a) => <Recording p={p} a={a} editable={can.settings(role)} onSaved={(x) => account.setData(() => x)} />}</LoadState>}
          {tab === "team" && <Team p={p} role={role} />}
          {tab === "signin" && <SignIn p={p} />}
          {tab === "audit" && <Audit p={p} />}
          {tab === "data" && <YourData p={p} a={account.data} role={role} />}
        </div>
      </div>
    </div>
  );
}

function timeZones(current: string): string[] {
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    /* older browsers */
  }
  if (!all.length) all = ["UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"];
  return [...new Set([current, "UTC", ...all])].filter(Boolean);
}

function Workspace({ p, a, editable, onSaved }: { p: PageProps; a: AccountX; editable: boolean; onSaved: (a: AccountX) => void }) {
  const hasTz = a.time_zone !== undefined;
  const [name, setName] = useState(a.name);
  const [tz, setTz] = useState(a.time_zone ?? "UTC");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const zones = useMemo(() => timeZones(a.time_zone ?? "UTC"), [a.time_zone]);
  const dirty = name.trim() !== a.name || (hasTz && tz !== a.time_zone);
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      onSaved(await patchAccount(ctxOf(p), { ...(name.trim() !== a.name ? { name: name.trim() } : {}), ...(hasTz && tz !== a.time_zone ? { time_zone: tz } : {}) }));
      setMsg({ text: "Saved." });
    } catch (e) {
      setMsg({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="adm-stack" aria-labelledby="ws-h">
      <h2 id="ws-h" className="adm-h2-lg">Workspace</h2>
      <label className="adm-card adm-field" style={{ padding: 16 }}>
        <span style={{ fontWeight: 500 }}>Name</span>
        <input className="adm-input adm-input-dark adm-input-lg" value={name} maxLength={120} disabled={!editable} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="adm-card adm-field" style={{ padding: 16 }}>
        <label htmlFor="ws-tz" style={{ fontWeight: 500 }}>Time zone</label>
        <select id="ws-tz" aria-describedby="ws-tz-note" className="adm-select adm-select-dark adm-input-lg" value={tz} disabled={!editable || !hasTz} onChange={(e) => setTz(e.target.value)}>
          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
        <span id="ws-tz-note" className="adm-small adm-muted">{hasTz ? "Used for watch schedules and answers like “this morning”." : "Setting a time zone isn't available on this server yet; it uses UTC."}</span>
      </div>
      <div className="adm-row">
        <button type="button" className="adm-btn adm-btn-primary" disabled={!editable || !dirty || busy || !name.trim()} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        {msg && <span role={msg.error ? "alert" : "status"} className={msg.error ? "adm-error" : "adm-small adm-ok"}>{msg.text}</span>}
      </div>
    </section>
  );
}

function Recording({ p, a, editable, onSaved }: { p: PageProps; a: AccountX; editable: boolean; onSaved: (a: AccountX) => void }) {
  const sources = useSources(p);
  const [mode, setMode] = useState<"days" | "fill">(a.retention_mode);
  const [days, setDays] = useState(String(a.retention_days ?? 7));
  const [audio, setAudio] = useState(a.record_audio_default ?? false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const max = a.retention_max_days;
  const n = Number(days);
  const valid = mode === "fill" || (Number.isInteger(n) && n >= 1 && (max === null || n <= max));
  const dirty = mode !== a.retention_mode || (mode === "days" && n !== a.retention_days) || (a.record_audio_default !== undefined && audio !== a.record_audio_default);
  const res = sources.list.find((s) => s.max_resolution)?.max_resolution ?? "720p";
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      onSaved(await patchAccount(ctxOf(p), {
        retention_mode: mode,
        ...(mode === "days" ? { retention_days: n } : {}),
        ...(a.record_audio_default !== undefined ? { record_audio_default: audio } : {}),
      }));
      setMsg({ text: "Saved." });
    } catch (e) {
      setMsg({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="adm-stack" style={{ gap: 16 }} aria-labelledby="rec-h">
      <h2 id="rec-h" className="adm-h2-lg">Recording defaults</h2>
      <p className="adm-muted">New cameras start with these. Each camera can override them.</p>
      <fieldset className="adm-card adm-stack" style={{ margin: 0, padding: 18, gap: 12 }} disabled={!editable}>
        <legend style={{ padding: "0 6px", fontWeight: 500 }}>Keep recordings</legend>
        <label className="adm-opt">
          <input type="radio" name="ret" checked={mode === "days"} onChange={() => setMode("days")} />
          <span className="adm-col"><span>For a number of days</span><span className="adm-small adm-muted">Older recordings are deleted every night.{max !== null ? ` Up to ${max} days on this workspace.` : ""}</span></span>
          <input type="number" aria-label="Days" min={1} max={max ?? undefined} value={days} disabled={mode !== "days" || !editable} onChange={(e) => setDays(e.target.value)} className="adm-input adm-input-dark" style={{ marginLeft: "auto", width: 72, borderRadius: 6 }} />
        </label>
        <label className="adm-opt">
          <input type="radio" name="ret" checked={mode === "fill"} onChange={() => setMode("fill")} />
          <span className="adm-col"><span>Until storage is full</span><span className="adm-small adm-muted">The oldest recordings are removed to make room.</span></span>
        </label>
        <span className="adm-note">Saved clips and event snapshots are kept separately.</span>
      </fieldset>
      <div className="adm-tiles-2">
        <label className="adm-card adm-toggle-card">
          <span className="adm-col"><span style={{ fontWeight: 500 }}>Record audio</span><span className="adm-small adm-muted">{a.record_audio_default !== undefined ? "Off by default. Sounds are still analysed." : "Off by default. Turn it on per camera."}</span></span>
          <input type="checkbox" className="adm-check" checked={audio} disabled={!editable || a.record_audio_default === undefined} onChange={(e) => setAudio(e.target.checked)} />
        </label>
        <div className="adm-card adm-toggle-card">
          <span className="adm-col"><span style={{ fontWeight: 500 }}>Maximum resolution</span><span className="adm-small adm-muted">Streams above it are refused.</span></span>
          <span className="adm-mono adm-soft">{res}</span>
        </div>
      </div>
      <div className="adm-row">
        <button type="button" className="adm-btn adm-btn-primary" disabled={!editable || !dirty || !valid || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
        {!valid && <span className="adm-error">Pick between 1 and {max ?? "any number of"} days.</span>}
        {msg && <span role={msg.error ? "alert" : "status"} className={msg.error ? "adm-error" : "adm-small adm-ok"}>{msg.text}</span>}
      </div>
    </section>
  );
}

const initials = (s: string) => s.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join("");

function Team({ p, role }: { p: PageProps; role: Role }) {
  const ctx = ctxOf(p);
  const editable = can.team(role);
  const members = useLoad(() => listMembers(ctx), [p.apiUrl, p.apiKey]);
  const invites = useLoad(() => listInvites(ctx), [p.apiUrl, p.apiKey]);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [err, setErr] = useState<unknown>();
  const change = async (m: Member, r: Role) => {
    setErr(undefined);
    try {
      const u = await updateMember(ctx, m.id, r);
      members.setData((l) => l?.map((x) => (x.id === m.id ? { ...x, ...u, role: u?.role ?? r } : x)));
    } catch (e) {
      setErr(e);
    }
  };
  if (members.missing) return (<section className="adm-stack"><h2 className="adm-h2-lg">Team</h2><Unavailable what="Team members" /></section>);
  return (
    <section className="adm-stack" aria-labelledby="team-h">
      <div className="adm-row" style={{ justifyContent: "space-between" }}>
        <h2 id="team-h" className="adm-h2-lg">Team</h2>
        <button type="button" className="adm-btn adm-btn-primary" style={{ height: 36, padding: "0 14px" }} disabled={!editable || invites.missing} onClick={() => setInviting(true)}>Invite someone</button>
      </div>
      <ErrorNote error={err} />
      <LoadState r={members} what="Team members">
        {(list) => (
          <div className="adm-card" style={{ overflow: "hidden" }}>
            {list.map((m) => (
              <div key={m.id} className="adm-member">
                <span className="adm-avatar" aria-hidden="true">{initials(m.name || m.email)}</span>
                <span className="adm-col" style={{ flex: 1, minWidth: 180 }}><span>{m.name || m.email}</span><span className="adm-small adm-muted">{m.email}</span></span>
                {m.role === "owner" ? <span className="adm-soft" style={{ padding: "0 10px" }}>Owner</span> : (
                  <select className="adm-select adm-select-dark" aria-label={`Role for ${m.name || m.email}`} value={m.role} disabled={!editable || (role === "admin" && m.role === "admin")} onChange={(e) => void change(m, e.target.value as Role)} style={{ height: 32, borderRadius: 6 }}>
                    {ROLES.map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
                  </select>
                )}
                {m.role !== "owner" && <button type="button" className="adm-btn adm-btn-sm adm-btn-danger" disabled={!editable} aria-label={`Remove ${m.name || m.email}`} onClick={() => setRemoving(m)}>Remove</button>}
              </div>
            ))}
            {!list.length && <p className="adm-empty">Only you so far.</p>}
          </div>
        )}
      </LoadState>
      {!invites.missing && !!invites.data?.length && (
        <div className="adm-section">
          <h3 className="adm-h2" style={{ fontSize: 14 }}>Pending invites</h3>
          <div className="adm-card" style={{ overflow: "hidden" }}>
            {invites.data.map((i: Invite) => (
              <div key={i.id} className="adm-member">
                <span className="adm-col" style={{ flex: 1, minWidth: 180 }}><span>{i.email}</span><span className="adm-small adm-muted">{roleName(i.role)} · expires {fmtDate(i.expires_at)}</span></span>
                {i.invite_url && <CopyButton text={i.invite_url} label="Copy link" />}
                <button type="button" className="adm-btn adm-btn-sm adm-btn-danger" disabled={!editable} onClick={() => void revokeInvite(ctx, i.id).then(() => invites.setData((l) => l?.filter((x) => x.id !== i.id))).catch(setErr)}>Revoke</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {inviting && <InviteDialog p={p} canAdmin={role === "owner"} onClose={() => setInviting(false)} onInvited={(i) => invites.setData((l) => [i, ...(l ?? [])])} />}
      {removing && (
        <Confirm title={`Remove ${removing.name || removing.email}?`} action="Remove" body="They lose access to this workspace at once." onClose={() => setRemoving(null)}
          onConfirm={async () => { await removeMember(ctx, removing.id); members.setData((l) => l?.filter((x) => x.id !== removing.id)); }} />
      )}
    </section>
  );
}

function InviteDialog({ p, canAdmin, onClose, onInvited }: { p: PageProps; canAdmin: boolean; onClose: () => void; onInvited: (i: Invite) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [link, setLink] = useState("");
  const send = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const i = await createInvite(ctxOf(p), email.trim(), role);
      onInvited({ ...i, email: i.email ?? email.trim(), role: i.role ?? role });
      setLink(i.invite_url);
    } catch (e) {
      setErr(unavailable(e) ? "Inviting people isn't available on this server yet." : e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="Invite someone" onClose={onClose}>
      {link ? (
        <>
          <div className="adm-secret" role="status">
            <span>Send this link to {email}. It works once.</span>
            <div className="adm-code"><code>{link}</code><CopyButton text={link} /></div>
          </div>
          <div className="adm-dialog-foot"><button type="button" className="adm-btn adm-btn-primary" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          <label className="adm-field"><span className="adm-small adm-muted">Email</span><input className="adm-input adm-input-dark adm-input-lg" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sam@example.com" /></label>
          <label className="adm-field"><span className="adm-small adm-muted">Role</span>
            <select className="adm-select adm-select-dark adm-input-lg" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.filter((r) => r !== "admin" || canAdmin).map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
            </select>
          </label>
          <p className="adm-note">Admins can change everything except deleting the workspace. Members can add watches and clips. Viewers can only look.</p>
          <ErrorNote error={err} />
          <div className="adm-dialog-foot">
            <button type="button" className="adm-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="adm-btn adm-btn-primary" disabled={busy || !/^\S+@\S+\.\S+$/.test(email.trim())} onClick={() => void send()}>{busy ? "Creating…" : "Create invite link"}</button>
          </div>
        </>
      )}
    </Dialog>
  );
}

function SignIn({ p }: { p: PageProps }) {
  const r = useLoad(() => getAuthProviders(ctxOf(p)), [p.apiUrl, p.apiKey]);
  return (
    <section className="adm-stack" aria-labelledby="si-h">
      <h2 id="si-h" className="adm-h2-lg">Sign-in</h2>
      <p className="adm-muted">These are set in the server's configuration and can't be changed here.</p>
      <LoadState r={r} what="Sign-in settings">
        {(m) => (
          <div className="adm-card" style={{ overflow: "hidden" }}>
            {[
              { name: "Email and password", note: "Passwords need at least 10 characters", on: m.password },
              { name: "Google", note: "Anyone with a Google account you invite", on: m.google },
              { name: "GitHub", note: "Anyone with a GitHub account you invite", on: m.github },
              { name: "Open sign-up", note: "Anyone can create a new workspace on this server", on: m.signup },
            ].map((s) => (
              <div key={s.name} className="adm-member" style={{ justifyContent: "space-between" }}>
                <span className="adm-col"><span>{s.name}</span><span className="adm-small adm-muted">{s.note}</span></span>
                <span className={s.on ? "adm-ok" : "adm-muted"} aria-label={`${s.name}: ${s.on ? "on" : "off"}`}>{s.on ? "On" : "Off"}</span>
              </div>
            ))}
          </div>
        )}
      </LoadState>
    </section>
  );
}

export type { AuditEntry };

/** Turns an audit row ("GET /v1/sources/:id/now") into words. */
export function describeAudit(e: AuditEntry, name: (id: string) => string): string {
  const target = e.target ? name(e.target) : "";
  const [method, route = ""] = e.action.split(" ");
  const phrases: [RegExp, string][] = [
    [/^GET \/v1\/sources\/:id\/now$/, `Looked at ${target}`],
    [/^POST \/v1\/sources\/:id\/ask$/, `Asked about ${target}`],
    [/^GET \/v1\/sources\/:id\/playback$/, `Replayed ${target}`],
    [/^POST \/v1\/sources\/:id\/live$/, `Watched ${target} live`],
    [/^PATCH \/v1\/sources\/:id$/, `Changed ${target}`],
    [/^DELETE \/v1\/sources\/:id$/, `Removed ${target}`],
    [/^POST \/v1\/sources$/, "Added a camera"],
    [/^POST \/v1\/watches$/, "Created a watch"],
    [/^PATCH \/v1\/watches\/:id$/, "Changed a watch"],
    [/^DELETE \/v1\/watches\/:id$/, "Deleted a watch"],
    [/^POST \/v1\/agents$/, "Created an API key"],
    [/^POST \/v1\/agents\/connect$/, "Approved an app"],
    [/^app\.connected $/, `Connected ${target || "an app"}`],
    [/^DELETE \/v1\/agents\/:id$/, `Revoked ${target || "an agent"}`],
    [/^POST \/v1\/grants$/, "Gave an agent access"],
    [/^DELETE \/v1\/grants\/:id$/, "Took away an agent's access"],
    [/^POST \/v1\/clips$/, "Saved a clip"],
    [/^DELETE \/v1\/clips\/:id$/, "Deleted a clip"],
    [/^POST \/v1\/webhooks$/, "Added a webhook"],
    [/^DELETE \/v1\/webhooks\/:id$/, "Deleted a webhook"],
    [/^POST \/v1\/account\/export$/, "Started a data export"],
    [/^PATCH \/v1\/account$/, "Changed workspace settings"],
  ];
  const hit = phrases.find(([re]) => re.test(`${method} ${route}`));
  return hit ? hit[1] : `${e.action}${target ? ` · ${target}` : ""}`;
}

function Audit({ p }: { p: PageProps }) {
  const ctx = ctxOf(p);
  const sources = useSources(p);
  const agents = useLoad(() => p.client.agents.list().then((r) => (r as { data: { id: string; name: string }[] }).data), [p.apiUrl, p.apiKey]);
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const page = async (c: string | null) => {
    setLoading(true);
    try {
      const r = await api<{ data: AuditEntry[]; next_cursor: string | null }>(ctx, "GET", `/audit?limit=50${c ? `&cursor=${encodeURIComponent(c)}` : ""}`);
      setRows((cur) => (c ? [...cur, ...r.data] : r.data));
      setCursor(r.next_cursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => void page(null), [p.apiUrl, p.apiKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (id: string) => (id.startsWith("src_") ? sources.name(id) : agents.data?.find((a) => a.id === id)?.name ?? id);
  const who = (actor: string) => {
    if (actor.startsWith("agent:")) return agents.data?.find((a) => a.id === actor.slice(6))?.name ?? "An agent";
    if (actor.startsWith("owner:")) return `Owner key ${actor.slice(6)}…`;
    if (actor.startsWith("user:")) return actor.slice(5);
    return actor;
  };
  return (
    <section className="adm-stack" aria-labelledby="au-h">
      <h2 id="au-h" className="adm-h2-lg">Audit log</h2>
      <p className="adm-muted">Who looked at what, and what changed.</p>
      {error !== undefined ? (unavailable(error) ? <Unavailable what="The audit log" /> : <ErrorNote error={error} />) : (
        <>
          <div className="adm-table-wrap">
            <table className="adm-table adm-table-dense" style={{ minWidth: 600 }}>
              <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td className="adm-mono adm-small adm-muted" style={{ whiteSpace: "nowrap" }}>{dayLabel(e.occurred_at) === "Today" ? fmtHm(e.occurred_at) : `${dayLabel(e.occurred_at)} ${fmtHm(e.occurred_at)}`}</td>
                    <td>{who(e.actor)}</td>
                    <td className="adm-soft">{describeAudit(e, name)}{e.status && e.status >= 400 ? <span className="adm-error"> (refused)</span> : null}</td>
                  </tr>
                ))}
                {!loading && !rows.length && <tr><td colSpan={3} className="adm-empty">Nothing yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {cursor && <div className="adm-more"><button type="button" className="adm-btn adm-btn-ghost" disabled={loading} onClick={() => void page(cursor)}>{loading ? "Loading…" : "Load older"}</button></div>}
        </>
      )}
    </section>
  );
}

function YourData({ p, a, role }: { p: PageProps; a: AccountX | undefined; role: Role }) {
  const [exp, setExp] = useState<{ export_id: string; status: string; url?: string } | null>(null);
  const [err, setErr] = useState<unknown>();
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const client: Senseplane = p.client;
  useInterval(() => {
    if (!exp || exp.status === "ready") return;
    void client.account.exportStatus(exp.export_id).then((x) => setExp(x as typeof exp)).catch(setErr);
  }, exp && exp.status !== "ready" ? 3000 : null);
  const start = async () => {
    setErr(undefined);
    try {
      setExp((await client.account.export()) as typeof exp);
    } catch (e) {
      setErr(unavailable(e) ? "Exports aren't available on this server yet." : e);
    }
  };
  if (deleted) return <p role="status" className="adm-card adm-empty">The workspace is being deleted. Your keys have stopped working.</p>;
  return (
    <section className="adm-stack" aria-labelledby="yd-h">
      <h2 id="yd-h" className="adm-h2-lg">Your data</h2>
      <div className="adm-card adm-card-pad adm-row" style={{ justifyContent: "space-between", gap: 12 }}>
        <span className="adm-col"><span style={{ fontWeight: 500 }}>Export everything</span><span className="adm-small adm-muted">Cameras, events, watches, clips and the audit log as a JSON download, with links to the media.</span></span>
        {exp?.status === "ready" && exp.url
          ? <a className="adm-btn adm-btn-primary" href={exp.url} download>Download export</a>
          : <button type="button" className="adm-btn" style={{ height: 36, padding: "0 14px" }} disabled={!can.settings(role) || (exp !== null && exp.status !== "ready")} onClick={() => void start()}>{exp ? "Preparing…" : "Start export"}</button>}
      </div>
      {exp?.status === "ready" && <p role="status" className="adm-small adm-muted">Your export is ready. The link works for an hour.</p>}
      <ErrorNote error={err} />
      {can.deleteWorkspace(role) && (
        <div className="adm-card adm-card-pad adm-danger-card adm-row" style={{ justifyContent: "space-between", gap: 12 }}>
          <span className="adm-col"><span className="adm-danger-text" style={{ fontWeight: 500 }}>Delete workspace</span><span className="adm-small adm-muted">Deletes every camera, recording and key. This cannot be undone.</span></span>
          <button type="button" className="adm-btn adm-btn-danger" style={{ height: 36, padding: "0 14px" }} disabled={!a} onClick={() => setDeleting(true)}>Delete workspace</button>
        </div>
      )}
      {deleting && a && (
        <Confirm title="Delete this workspace?" action="Delete workspace" confirmText={a.name}
          body="Every camera, recording, clip, event, watch and key is deleted. Keys stop working at once."
          onClose={() => setDeleting(false)}
          onConfirm={async () => { await client.account.delete(); setDeleted(true); p.navigate("/"); }} />
      )}
    </section>
  );
}
