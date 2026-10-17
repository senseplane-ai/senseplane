// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Webhooks: endpoints with their health, add and edit, the signing secret,
// a 24-hour summary and the delivery log with Resend.
import { useEffect, useState } from "react";
import type { Delivery, Webhook } from "senseplane";
import { errorText, rotateWebhookSecret, testWebhook, unavailable, updateWebhook } from "./api";
import {
  type PageProps, Confirm, CopyButton, Dialog, ErrorNote, Header, LoadState, MultiChips, can, ctxOf, dayLabel, fmtTime,
  roleNote, useLoad, useRole,
} from "./kit";

// detection.* is every detector label, everyday objects included (detection.cup, detection.laptop, …).
export const EVENT_TYPES = [
  "watch.triggered", "detection.person", "detection.vehicle", "detection.animal", "detection.*", "sound.detected",
  "sensor.threshold", "reading.threshold", "source.online", "source.offline", "source.view_changed",
];
const typeLabel = (t: string) => (t === "detection.*" ? "detection.* (people, vehicles, animals and objects)" : t);

type D = Delivery & { event_type?: string; duration_ms?: number | null };
type Health = { text: string; tone: "ok" | "retry" | "bad" | "none" };

/** Health from the newest deliveries: failing, retrying, or the share delivered. */
export function healthOf(ds: D[]): Health {
  if (!ds.length) return { text: "No deliveries yet", tone: "none" };
  if (ds[0]!.status === "failed") {
    let i = 0;
    while (i < ds.length && ds[i]!.status === "failed") i++;
    const since = ds[i - 1]!.created_at;
    return { text: `Failing since ${dayLabel(since) === "Today" ? fmtTime(since).slice(0, 5) : dayLabel(since)}`, tone: "bad" };
  }
  if (ds.some((d) => d.status === "pending" && d.attempts > 0)) return { text: "Retrying", tone: "retry" };
  const done = ds.filter((d) => d.status !== "pending");
  const pct = done.length ? Math.round((done.filter((d) => d.status === "delivered").length / done.length) * 100) : 100;
  return { text: `${pct}% delivered`, tone: pct === 100 ? "ok" : pct >= 80 ? "retry" : "bad" };
}

export function last24(ds: D[], now = Date.now()): string {
  const recent = ds.filter((d) => now - new Date(d.created_at).getTime() < 86_400_000);
  if (!recent.length) return "Nothing sent";
  const ok = recent.filter((d) => d.status === "delivered").length;
  const waiting = recent.filter((d) => d.status === "pending").length;
  if (ok === recent.length) return `${recent.length} sent, all delivered`;
  if (waiting) return `${recent.length} sent, ${waiting} waiting to retry`;
  return `${ok} of ${recent.length} delivered`;
}

const toneColor = { ok: "var(--live)", retry: "var(--warn)", bad: "var(--danger)", none: "var(--line-3)" };

async function deliveries(p: PageProps, id: string, max: number): Promise<D[]> {
  const out: D[] = [];
  for await (const d of p.client.webhooks.deliveries(id)) {
    out.push(d as D);
    if (out.length >= max) break;
  }
  return out;
}

export function WebhooksPage(p: PageProps) {
  const ctx = ctxOf(p);
  const { role } = useRole(ctx);
  const editable = can.webhooks(role);
  const hooks = useLoad(async () => {
    const list: Webhook[] = [];
    for await (const h of p.client.webhooks.list()) list.push(h);
    const recent = await Promise.all(list.map((h) => deliveries(p, h.id, 20).catch(() => [] as D[])));
    return list.map((h, i) => ({ hook: h, recent: recent[i]! }));
  }, [p.apiUrl, p.apiKey]);
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState<Webhook | "new" | null>(null);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const list = hooks.data ?? [];
  const current = list.find((x) => x.hook.id === sel) ?? list[0];

  return (
    <div className="adm">
      <Header eyebrow="Webhooks" title="Send events to your systems">
        <button type="button" className="adm-btn adm-btn-primary adm-btn-lg" disabled={!editable} onClick={() => setForm("new")}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>Add endpoint
        </button>
      </Header>
      {!editable && <p className="adm-note">{roleNote[role] || "Only owners and admins can change webhooks."}</p>}

      <LoadState r={hooks} what="Webhooks">
        {() => list.length ? (
          <div className="adm-split">
            <section aria-label="Endpoints" className="adm-card adm-ep-list">
              {list.map(({ hook, recent }) => {
                const h = healthOf(recent);
                return (
                  <button key={hook.id} type="button" className="adm-ep" aria-pressed={current?.hook.id === hook.id} onClick={() => setSel(hook.id)}>
                    <span className="adm-row" style={{ flexWrap: "nowrap" }}><span className="adm-dot" style={{ background: toneColor[h.tone] }} aria-hidden="true" /><span className="adm-ep-url">{hook.url}</span></span>
                    <span className="adm-small adm-muted">{hook.events.length === 1 ? "1 event type" : `${hook.events.length} event types`} · {h.text}</span>
                  </button>
                );
              })}
            </section>
            {current && (
              <Detail key={current.hook.id} p={p} hook={current.hook} editable={editable} onEdit={() => setForm(current.hook)} onDelete={() => setDeleting(current.hook)} onSecret={setSecret} />
            )}
          </div>
        ) : <p className="adm-card adm-empty">No endpoints yet. Add one to get events as signed HTTPS requests.</p>}
      </LoadState>

      {form && (
        <EndpointForm p={p} hook={form === "new" ? undefined : form} onClose={() => setForm(null)}
          onSaved={(h, s) => { setForm(null); setSel(h.id); if (s) setSecret({ title: "Signing secret", value: s }); void hooks.reload(); }} />
      )}
      {secret && (
        <Dialog title={secret.title} onClose={() => setSecret(null)}>
          <div className="adm-secret" role="status">
            <span>Copy it now. It is shown only once.</span>
            <div className="adm-code"><code>{secret.value}</code><CopyButton text={secret.value} /></div>
          </div>
          <p className="adm-small adm-muted">Every delivery carries a <code className="adm-mono">Senseplane-Signature</code> header signed with it. Check it with <code className="adm-mono">sp.webhooks.verify(body, header, secret)</code>.</p>
          <div className="adm-dialog-foot"><button type="button" className="adm-btn adm-btn-primary" onClick={() => setSecret(null)}>Done</button></div>
        </Dialog>
      )}
      {deleting && (
        <Confirm title="Delete this endpoint?" action="Delete endpoint" body={<>Senseplane stops sending to <span className="adm-mono">{deleting.url}</span>. Watches that sent to it stop sending there too.</>}
          onClose={() => setDeleting(null)}
          onConfirm={async () => { await p.client.webhooks.delete(deleting.id); setSel(null); hooks.setData((l) => l?.filter((x) => x.hook.id !== deleting.id)); }} />
      )}
    </div>
  );
}

function Detail({ p, hook, editable, onEdit, onDelete, onSecret }: { p: PageProps; hook: Webhook; editable: boolean; onEdit: () => void; onDelete: () => void; onSecret: (s: { title: string; value: string }) => void }) {
  const ctx = ctxOf(p);
  const log = useLoad(() => deliveries(p, hook.id, 200), [hook.id]);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState("");
  useEffect(() => setMsg(null), [hook.id]);
  const act = async (what: string, fn: () => Promise<void>, missing: string) => {
    setBusy(what);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ text: unavailable(e) ? missing : errorText(e), error: true });
    } finally {
      setBusy("");
    }
  };
  const resend = (d: D) => act(d.id, async () => {
    await p.client.webhooks.redeliver(hook.id, d.id);
    setMsg({ text: "Queued again." });
    await log.reload();
  }, "Resending isn't available on this server yet.");

  return (
    <section aria-label="Endpoint detail" className="adm-ep-detail">
      <div className="adm-card adm-card-pad adm-stack">
        <div className="adm-row" style={{ justifyContent: "space-between" }}>
          <span className="adm-mono" style={{ fontSize: 14, wordBreak: "break-all" }}>{hook.url}</span>
          <span className="adm-row" style={{ gap: 6 }}>
            <button type="button" className="adm-btn" disabled={!editable || busy !== ""} onClick={() => void act("test", async () => { await testWebhook(ctx, hook.id); setMsg({ text: "Test event sent. It shows in the log below." }); await log.reload(); }, "Sending a test event isn't available on this server yet.")}>Send test event</button>
            <button type="button" className="adm-btn" disabled={!editable} onClick={onEdit}>Edit</button>
            <button type="button" className="adm-btn adm-btn-danger" disabled={!editable} onClick={onDelete}>Delete</button>
          </span>
        </div>
        <dl className="adm-dl adm-dl-wide">
          <dt>Sends</dt><dd className="adm-mono adm-small adm-soft">{hook.events.join(", ")}</dd>
          <dt>Signing secret</dt>
          <dd className="adm-row"><span className="adm-mono adm-small adm-soft">whsec_••••••••••••</span>
            <button type="button" className="adm-btn adm-btn-sm adm-btn-ghost" style={{ height: 26 }} disabled={!editable || busy !== ""}
              onClick={() => void act("rotate", async () => { const r = await rotateWebhookSecret(ctx, hook.id); onSecret({ title: "New signing secret", value: r.secret }); }, "Rotating the secret isn't available on this server yet. Delete and add the endpoint again for a new one.")}>Rotate</button>
          </dd>
          <dt>Last 24 hours</dt><dd>{log.data ? last24(log.data) : "…"}</dd>
        </dl>
        {msg && <p role={msg.error ? "alert" : "status"} className={msg.error ? "adm-error" : "adm-small adm-ok"}>{msg.text}</p>}
      </div>

      <div className="adm-table-wrap">
        <table className="adm-table adm-table-dense" style={{ minWidth: 600 }}>
          <caption>Recent deliveries</caption>
          <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Response</th><th scope="col">Took</th><th scope="col"><span className="adm-sr">Actions</span></th></tr></thead>
          <tbody>
            {(log.data ?? []).slice(0, 30).map((d) => {
              const tone = d.status === "delivered" ? "ok" : d.status === "pending" ? "retry" : "bad";
              const retry = d.status === "pending" && d.next_attempt_at ? ` · retry ${dayLabel(d.next_attempt_at) === "Today" ? `at ${fmtTime(d.next_attempt_at).slice(0, 5)}` : "later"}` : "";
              const code = d.last_status_code ? String(d.last_status_code) : d.last_error ? d.last_error : d.status === "pending" ? "Waiting" : d.status;
              return (
                <tr key={d.id}>
                  <td className="adm-mono adm-small adm-muted">{dayLabel(d.created_at) === "Today" ? "" : `${dayLabel(d.created_at)} `}{fmtTime(d.created_at)}</td>
                  <td className="adm-mono adm-small">{d.event_type ?? d.event_id}</td>
                  <td><span className="adm-row adm-mono adm-small" style={{ gap: 6, color: toneColor[tone] }}><span className="adm-dot" style={{ width: 6, height: 6, background: toneColor[tone] }} aria-hidden="true" />{code}{retry}</span></td>
                  <td className="adm-mono adm-small adm-muted">{typeof d.duration_ms === "number" ? (d.duration_ms >= 1000 ? `${(d.duration_ms / 1000).toFixed(1)} s` : `${d.duration_ms} ms`) : "—"}</td>
                  <td className="adm-actions"><button type="button" className="adm-btn adm-btn-sm adm-btn-ghost" style={{ height: 28 }} disabled={!editable || busy !== ""} onClick={() => void resend(d)}>Resend</button></td>
                </tr>
              );
            })}
            {log.data && !log.data.length && <tr><td colSpan={5} className="adm-empty">Nothing sent yet. Send a test event to try it.</td></tr>}
            {log.error !== undefined && <tr><td colSpan={5}><ErrorNote error={log.error} /></td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EndpointForm({ p, hook, onClose, onSaved }: { p: PageProps; hook?: Webhook; onClose: () => void; onSaved: (h: Webhook, secret?: string) => void }) {
  const [url, setUrl] = useState(hook?.url ?? "");
  const [events, setEvents] = useState<string[]>(hook?.events ?? ["watch.triggered"]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const valid = /^https?:\/\/\S+$/.test(url.trim()) && events.length > 0;
  const save = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      if (hook) onSaved(await updateWebhook(ctxOf(p), hook.id, { url: url.trim(), events }));
      else {
        const h = await p.client.webhooks.create({ url: url.trim(), events });
        onSaved(h, h.secret);
      }
    } catch (e) {
      setErr(hook && unavailable(e) ? "Editing endpoints isn't available on this server yet. Delete it and add it again to change it." : e);
      setBusy(false);
    }
  };
  return (
    <Dialog title={hook ? "Edit endpoint" : "Add endpoint"} onClose={onClose} wide>
      <label className="adm-field">
        <span className="adm-small adm-muted">URL</span>
        <input className="adm-input adm-input-dark adm-input-lg adm-mono" type="url" value={url} placeholder="https://example.com/hooks/senseplane" onChange={(e) => setUrl(e.target.value)} />
      </label>
      <fieldset className="adm-fieldset">
        <legend className="adm-legend">Event types <span className="adm-legend-count">{events.length}</span></legend>
        <MultiChips all="All event types" items={EVENT_TYPES.map((t) => ({ id: t, label: typeLabel(t) }))} value={events} onChange={setEvents} />
      </fieldset>
      <ErrorNote error={err} />
      <div className="adm-dialog-foot">
        <button type="button" className="adm-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="adm-btn adm-btn-primary" disabled={busy || !valid} onClick={() => void save()}>{busy ? "Saving…" : hook ? "Save" : "Add endpoint"}</button>
      </div>
    </Dialog>
  );
}
