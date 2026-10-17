// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Events: everything Senseplane noticed, newest first, with a detail panel
// (snapshot, clip, what checked it, where it was sent) and relevance feedback.
// New events arrive by polling the first page; "Load older" follows the cursor.
import { useEffect, useMemo, useState } from "react";
import type { Webhook } from "senseplane";
import { labelText } from "../../shell/sources";
import { type EventX, type WatchX, errorText, listEvents, unavailable } from "./api";
import {
  type PageProps, ErrorNote, Header, HlsVideo, Snapshot, Thumb, Unavailable, can, ctxOf, fmtHm, fmtTime, hostOf,
  joinAnd, useInterval, useLoad, useRole, useSources, whenPhrase,
} from "./kit";

type Kind = "all" | "watch" | "det" | "alert";
type RangeId = "today" | "7d" | "30d" | "custom";

export const kindOf = (type: string): Exclude<Kind, "all"> =>
  type === "watch.triggered" ? "watch" : type.startsWith("detection.") || type === "sound.detected" ? "det" : "alert";

const KINDS: [Kind, string][] = [["all", "All"], ["watch", "Watches fired"], ["det", "Detections"], ["alert", "Alerts"]];
const POLL_MS = 10_000;
const PAGE = 30;

function rangeOf(id: RangeId, custom: { from: string; to: string }, now = new Date()): { from?: string; to?: string } {
  if (id === "today") return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString() };
  if (id === "7d") return { from: new Date(now.getTime() - 7 * 86_400_000).toISOString() };
  if (id === "30d") return { from: new Date(now.getTime() - 30 * 86_400_000).toISOString() };
  return {
    ...(custom.from ? { from: new Date(custom.from).toISOString() } : {}),
    ...(custom.to ? { to: new Date(custom.to).toISOString() } : {}),
  };
}

const pillClass = (k: Exclude<Kind, "all">) => (k === "watch" ? "adm-pill adm-pill-watch" : k === "alert" ? "adm-pill adm-pill-alert" : "adm-pill");

export function EventsPage(p: PageProps) {
  const ctx = ctxOf(p);
  const { role } = useRole(ctx);
  const sources = useSources(p);
  const [kind, setKind] = useState<Kind>("all");
  const [cam, setCam] = useState("");
  const [range, setRange] = useState<RangeId>("today");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [events, setEvents] = useState<EventX[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [olderBusy, setOlderBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [selId, setSelId] = useState<string | null>(null);

  // Context for the detail panel: which watch fired, and where it was sent.
  const ctxData = useLoad(async () => {
    const [watches, webhooks, agents] = await Promise.all([
      (async () => { const l: WatchX[] = []; for await (const w of p.client.watches.list()) l.push(w as WatchX); return l; })().catch(() => [] as WatchX[]),
      (async () => { const l: Webhook[] = []; for await (const w of p.client.webhooks.list()) l.push(w); return l; })().catch(() => [] as Webhook[]),
      p.client.agents.list().then((r) => (r as { data: { id: string; name: string }[] }).data).catch(() => [] as { id: string; name: string }[]),
    ]);
    return { watches: new Map(watches.map((w) => [w.id, w])), webhooks, agents: new Map(agents.map((a) => [a.id, a.name])) };
  }, [p.apiUrl, p.apiKey]);

  const query = useMemo(
    () => ({ source: cam || undefined, type: kind === "watch" ? "watch.triggered" : undefined, ...rangeOf(range, custom) }),
    // The range is computed when a filter changes, so "today" stays open-ended for live updates.
    [cam, kind, range, custom.from, custom.to], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    listEvents(ctx, { ...query, limit: PAGE })
      .then((page) => {
        if (!live) return;
        setEvents(page.data);
        setCursor(page.next_cursor);
      })
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [query, p.apiUrl, p.apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates: merge any new events from the first page into the top of the list.
  useInterval(() => {
    if (query.to) return;
    void listEvents(ctx, { ...query, limit: PAGE }).then((page) => {
      setEvents((cur) => {
        const seen = new Set(cur.map((e) => e.id));
        const fresh = page.data.filter((e) => !seen.has(e.id));
        return fresh.length ? [...fresh, ...cur].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)) : cur;
      });
    }).catch(() => undefined);
  }, error ? null : POLL_MS);

  const older = async () => {
    if (!cursor) return;
    setOlderBusy(true);
    try {
      const page = await listEvents(ctx, { ...query, cursor, limit: PAGE });
      setEvents((cur) => [...cur, ...page.data.filter((e) => !cur.some((c) => c.id === e.id))]);
      setCursor(page.next_cursor);
    } catch (e) {
      setError(e);
    } finally {
      setOlderBusy(false);
    }
  };

  const shown = events.filter((e) => kind === "all" || kindOf(e.type) === kind);
  const selected = shown.find((e) => e.id === selId) ?? shown[0];
  const camName = (e: EventX) => e.source.name ?? sources.byId.get(e.source.id)?.name ?? e.source.id;

  return (
    <div className="adm adm-tight">
      <Header eyebrow="Events" title="Everything Senseplane noticed">
        <span className="adm-live-note"><span className="adm-live-dot" aria-hidden="true" />New events appear here as they happen</span>
      </Header>

      <div className="adm-row">
        <div role="group" aria-label="Filter by kind" className="adm-chips">
          {KINDS.map(([id, label]) => (
            <button key={id} type="button" className="adm-chip adm-chip-lg" aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>
          ))}
        </div>
        <span className="adm-grow" />
        <label className="adm-label"><span>Camera</span>
          <select className="adm-select" value={cam} onChange={(e) => setCam(e.target.value)}>
            <option value="">All cameras</option>
            {sources.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="adm-label"><span>When</span>
          <select className="adm-select" value={range} onChange={(e) => setRange(e.target.value as RangeId)}>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        {range === "custom" && (
          <span className="adm-row">
            <label className="adm-label"><span>From</span><input className="adm-input" type="datetime-local" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
            <label className="adm-label"><span>To</span><input className="adm-input" type="datetime-local" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
          </span>
        )}
      </div>

      {error !== undefined && unavailable(error) ? <Unavailable what="The events feed" /> : (
        <div className="adm-split">
          <section aria-label="Event list" className="adm-card adm-ev-list" aria-busy={loading}>
            {shown.map((e) => {
              const k = kindOf(e.type);
              return (
                <button key={e.id} type="button" className="adm-ev" aria-pressed={selected?.id === e.id} onClick={() => setSelId(e.id)}>
                  <span className="adm-ev-time">{fmtTime(e.occurred_at)}</span>
                  <span className="adm-ev-thumb"><Thumb url={e.media.snapshot_url} /></span>
                  <span className="adm-col" style={{ gap: 3 }}>
                    <span>{e.summary}</span>
                    <span className="adm-ev-meta">
                      <span className={pillClass(k)}>{e.type}</span>
                      {camName(e)}
                      {e.verified === true && <span className="adm-verified"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>Verified</span>}
                    </span>
                  </span>
                </button>
              );
            })}
            {!loading && !shown.length && <p className="adm-empty">{error ? errorText(error) : "No events in this range yet."}</p>}
            {loading && !shown.length && <p className="adm-empty">Loading…</p>}
            {cursor && (
              <div className="adm-more">
                <button type="button" className="adm-btn adm-btn-ghost" disabled={olderBusy} onClick={() => void older()}>{olderBusy ? "Loading…" : "Load older events"}</button>
              </div>
            )}
          </section>

          {selected ? (
            <EventDetail key={selected.id} p={p} summary={selected} camName={camName(selected)} canFeedback={can.feedback(role)} ctxData={ctxData.data} />
          ) : (
            <section aria-label="Event detail" className="adm-card adm-ev-detail"><p className="adm-empty">Pick an event to see what happened.</p></section>
          )}
        </div>
      )}
    </div>
  );
}

interface CtxData {
  watches: Map<string, WatchX>;
  webhooks: Webhook[];
  agents: Map<string, string>;
}

/**
 * Where an event went: the watch's chosen destinations, or (no destinations
 * chosen, ADR 0043) every webhook subscribed to its type. The Events feed always has it.
 */
export function sentTo(e: EventX, d: CtxData | undefined): string {
  if (!d) return "…";
  const hookName = (h: Webhook) => `${hostOf(h.url)} webhook`;
  const watch = e.watch_id ? d.watches.get(e.watch_id) : undefined;
  if (watch?.notify?.length) {
    const names = watch.notify.map((x) => {
      if (x.type === "agent") return `${d.agents.get(x.id) ?? "An agent"} (agent)`;
      const h = d.webhooks.find((w) => w.id === x.id);
      return h ? hookName(h) : "A deleted webhook";
    });
    return joinAnd(names);
  }
  const hooks = d.webhooks.filter((h) => h.events.includes(e.type) || h.events.includes("*"));
  return hooks.length ? joinAnd(hooks.map(hookName)) : "Nobody";
}

function EventDetail({ p, summary, camName, canFeedback, ctxData }: { p: PageProps; summary: EventX; camName: string; canFeedback: boolean; ctxData: CtxData | undefined }) {
  // The list's signed URLs may have expired; fetch the event again for fresh ones.
  const fresh = useLoad(() => p.client.events.get(summary.id) as Promise<EventX>, [summary.id]);
  const e = fresh.data ?? summary;
  const [playing, setPlaying] = useState(false);
  const [feedback, setFeedback] = useState(e.feedback);
  const [msg, setMsg] = useState("");
  useEffect(() => setFeedback(e.feedback), [e.feedback]);
  const k = kindOf(e.type);
  const watch = e.watch_id ? ctxData?.watches.get(e.watch_id) : undefined;
  const conf = e.confidence !== null ? e.confidence.toFixed(2) : e.value ? `${e.value.value} ${e.value.unit}` : "n/a";
  const checked = e.verified === true ? "Yes, confirmed by the AI" : e.verified === false ? "No, fired on its trigger alone" : "No";

  const send = async (v: "relevant" | "not_relevant") => {
    setMsg("");
    try {
      await p.client.events.feedback(e.id, v);
      setFeedback(v);
      setMsg("Thanks. Feedback tunes this camera over time.");
    } catch (err) {
      setMsg(errorText(err));
    }
  };

  return (
    <section aria-label="Event detail" className="adm-card adm-ev-detail">
      <div className="adm-shot">
        {playing && e.media.clip_url ? <HlsVideo url={e.media.clip_url} label={`Clip: ${e.summary}`} /> : <Snapshot url={e.media.snapshot_url} alt={`Snapshot: ${e.summary}`} />}
        {!playing && e.labels[0] && <span className="adm-shot-label">{labelText(e.labels[0])}{e.confidence !== null ? ` ${e.confidence.toFixed(2)}` : ""}</span>}
        {!playing && <span className="adm-shot-tag" style={{ left: 10, bottom: 10 }}>SNAPSHOT · {fmtTime(e.occurred_at)}</span>}
        {e.media.clip_url && !playing && (
          <button type="button" className="adm-shot-play" onClick={() => setPlaying(true)}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>Play clip
          </button>
        )}
      </div>
      <div className="adm-stack" style={{ padding: 16 }}>
        <div className="adm-col" style={{ gap: 4 }}>
          <span className={`adm-mono adm-small ${k === "watch" ? "adm-ok" : k === "alert" ? "adm-retry" : "adm-soft"}`} style={{ fontSize: 11 }}>{e.type}</span>
          <h2 style={{ fontSize: 17, fontWeight: 500 }}>{e.summary}</h2>
          <span className="adm-muted" style={{ fontSize: 13 }}>{camName} · {whenPhrase(e.occurred_at)}{e.ended_at ? `–${fmtHm(e.ended_at)}` : ""}</span>
        </div>
        <dl className="adm-dl">
          <dt>Confidence</dt><dd className="adm-mono">{conf}</dd>
          <dt>Checked by AI</dt><dd>{checked}</dd>
          <dt>From watch</dt><dd>{watch ? watch.instruction : e.watch_id ? "A deleted watch" : "None"}</dd>
          <dt>Sent to</dt><dd>{sentTo(e, ctxData)}</dd>
        </dl>
        <div className="adm-row" style={{ paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <span className="adm-muted" style={{ fontSize: 13, marginRight: 4 }}>Was this useful?</span>
          <button type="button" className="adm-btn" aria-pressed={feedback === "relevant"} disabled={!canFeedback} onClick={() => void send("relevant")}>Yes</button>
          <button type="button" className="adm-btn" aria-pressed={feedback === "not_relevant"} disabled={!canFeedback} onClick={() => void send("not_relevant")}>Not relevant</button>
          {msg && <span role="status" className="adm-small adm-muted">{msg}</span>}
        </div>
        <ErrorNote error={fresh.error && !unavailable(fresh.error) ? fresh.error : undefined} />
        <details className="adm-details">
          <summary>Event JSON</summary>
          <pre className="adm-pre">{JSON.stringify(e, null, 2)}</pre>
        </details>
      </div>
    </section>
  );
}
