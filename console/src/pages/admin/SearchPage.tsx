// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Search history: find any moment in plain words (memory search), grouped by
// day; a result opens that camera's playback at that moment. The Saved clips
// tab plays, downloads and deletes clips.
import { useState } from "react";
import { type Clip, type Event, LABELS, detectionLabel } from "senseplane";
import { errorText, unavailable } from "./api";
import {
  type PageProps, Confirm, Dialog, ErrorNote, Header, HlsVideo, LoadState, Snapshot, Tabs, Unavailable, can, ctxOf,
  dayLabel, fmtDuration, fmtHm, fmtTime, useLoad, useRole, useSources,
} from "./kit";

type RangeId = "today" | "7d" | "30d";
type KindId = "all" | "people" | "vehicles" | "animals" | "objects" | "sounds";
// Everyday objects: every detector label but the three groups (spec/labels.json).
const OBJECTS: ReadonlySet<string> = new Set(LABELS.filter((l) => !("group" in l)).map((l) => l.label));
type Hit = { event: Event; score: number };

const fromOf = (r: RangeId, now = new Date()) =>
  r === "today" ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString() : new Date(now.getTime() - (r === "7d" ? 7 : 30) * 86_400_000).toISOString();

export function matchesKind(e: Event, k: KindId): boolean {
  if (k === "all") return true;
  if (k === "people") return e.type === "detection.person" || e.labels.includes("person");
  if (k === "vehicles") return e.type === "detection.vehicle" || e.labels.some((l) => ["vehicle", "car", "truck", "van", "bus", "motorcycle"].includes(l));
  if (k === "animals") return e.type === "detection.animal" || e.labels.includes("animal");
  if (k === "objects") return OBJECTS.has(detectionLabel(e.type) ?? "") || e.labels.some((l) => OBJECTS.has(l));
  return e.type === "sound.detected" || e.source.sense === "audio";
}

/** Groups hits by local day, keeping the API's order (best match first) inside each day; days newest first. */
export function groupByDay(hits: Hit[]): { day: string; items: Hit[] }[] {
  const sorted = [...hits].sort((a, b) => b.event.occurred_at.localeCompare(a.event.occurred_at));
  const out: { day: string; items: Hit[] }[] = [];
  for (const h of sorted) {
    const day = dayLabel(h.event.occurred_at);
    const g = out.find((x) => x.day === day);
    if (g) g.items.push(h);
    else out.push({ day, items: [h] });
  }
  return out;
}

export function SearchPage(p: PageProps) {
  const { role } = useRole(ctxOf(p));
  const sources = useSources(p);
  const [q, setQ] = useState("");
  const [cam, setCam] = useState("");
  const [range, setRange] = useState<RangeId>("7d");
  const [kind, setKind] = useState<KindId>("all");
  const [tab, setTab] = useState<"res" | "clips">("res");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const clips = useLoad(async () => {
    const l: Clip[] = [];
    for await (const c of p.client.clips.list()) l.push(c);
    return l;
  }, [p.apiUrl, p.apiKey]);

  const run = async (e?: React.FormEvent, r = range) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError(undefined);
    setTab("res");
    try {
      const res = await p.client.memory.search({ q: q.trim(), from: fromOf(r), to: new Date().toISOString(), limit: 50 });
      setHits(res.data as Hit[]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const shown = (hits ?? []).filter((h) => (!cam || h.event.source.id === cam) && matchesKind(h.event, kind));
  const days = groupByDay(shown);

  return (
    <div className="adm adm-tight">
      <Header eyebrow="Search history" title="Find any moment" />

      <form role="search" onSubmit={(e) => void run(e)}>
        <label className="adm-search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
          <span className="adm-sr">Search recordings</span>
          <input type="search" value={q} placeholder="person in a yellow jacket" onChange={(e) => setQ(e.target.value)} />
          <span className="adm-search-hint">{busy ? "Searching…" : "Describe it in plain words"}</span>
        </label>
        <button type="submit" className="adm-sr">Search</button>
      </form>

      <div className="adm-row">
        <select className="adm-select" aria-label="Cameras" value={cam} onChange={(e) => setCam(e.target.value)}>
          <option value="">All cameras</option>
          {sources.list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="adm-select" aria-label="Time range" value={range} onChange={(e) => { const r = e.target.value as RangeId; setRange(r); if (hits) void run(undefined, r); }}>
          <option value="7d">Last 7 days</option>
          <option value="today">Today</option>
          <option value="30d">Last 30 days</option>
        </select>
        <select className="adm-select" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as KindId)}>
          <option value="all">Everything</option>
          <option value="people">People</option>
          <option value="vehicles">Vehicles</option>
          <option value="animals">Animals</option>
          <option value="objects">Objects</option>
          <option value="sounds">Sounds</option>
        </select>
        <span className="adm-grow" />
        <Tabs label="Results or saved clips" value={tab} onChange={setTab} tabs={[
          { id: "res", label: <>Results <span className="adm-mono adm-muted" style={{ fontSize: 12 }}>{hits ? shown.length : ""}</span></> },
          { id: "clips", label: <>Saved clips <span className="adm-mono adm-muted" style={{ fontSize: 12 }}>{clips.data?.length ?? ""}</span></> },
        ]} />
      </div>

      {tab === "res" ? (
        <div role="tabpanel" aria-label="Results">
          {error !== undefined ? (unavailable(error) ? <Unavailable what="Search" /> : <ErrorNote error={error} />)
            : hits === null ? <p className="adm-card adm-empty">Describe what you're looking for, like “courier at the front door” or “van in the car park”.</p>
            : !days.length ? <p className="adm-card adm-empty">Nothing matched. Try other words or a longer time range.</p>
            : (
              <div className="adm-days">
                {days.map((d) => (
                  <section key={d.day} className="adm-day" aria-label={d.day}>
                    <h2>{d.day}</h2>
                    <div className="adm-tiles">
                      {d.items.map(({ event: e, score }) => (
                        <button key={e.id} type="button" className="adm-tile" onClick={() => p.navigate(`/cameras/${encodeURIComponent(e.source.id)}?t=${encodeURIComponent(e.occurred_at)}`)}>
                          <span className="adm-shot">
                            <Snapshot url={e.media.snapshot_url} alt="" />
                            <span className="adm-shot-tag adm-tile-time">{fmtTime(e.occurred_at)}</span>
                            <span className="adm-tile-match">{Math.round(score * 100)}%</span>
                          </span>
                          <span className="adm-tile-body">
                            <span style={{ fontSize: 13 }}>{e.summary}</span>
                            <span className="adm-small adm-muted">{sources.name(e.source.id)}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
        </div>
      ) : (
        <div role="tabpanel" aria-label="Saved clips">
          <LoadState r={clips} what="Saved clips">
            {(list) => <ClipTable clips={list} p={p} name={sources.name} canDelete={can.clips(role)} onDeleted={(id) => clips.setData((l) => l?.filter((c) => c.id !== id))} />}
          </LoadState>
        </div>
      )}
    </div>
  );
}

/** Joins a clip's HLS playlist (init + fMP4 segments) into one downloadable MP4 file. */
export async function downloadClip(playlistUrl: string, filename: string): Promise<void> {
  const text = await (await fetch(playlistUrl)).text();
  const parts: string[] = [];
  let init = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const map = line.match(/^#EXT-X-MAP:.*URI="([^"]+)"/);
    if (map) {
      if (map[1] !== init) parts.push((init = map[1]!));
    } else if (line && !line.startsWith("#")) parts.push(line);
  }
  if (!parts.length) throw new Error("This clip has no video.");
  const blobs: Blob[] = [];
  for (const u of parts) {
    const res = await fetch(new URL(u, playlistUrl));
    if (!res.ok) throw new Error(`Download failed (${res.status}).`);
    blobs.push(await res.blob());
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(blobs, { type: "video/mp4" }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

function ClipTable({ clips, p, name, canDelete, onDeleted }: { clips: Clip[]; p: PageProps; name: (id: string) => string; canDelete: boolean; onDeleted: (id: string) => void }) {
  const [playing, setPlaying] = useState<{ clip: Clip; url: string } | null>(null);
  const [deleting, setDeleting] = useState<Clip | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const fresh = async (c: Clip) => (await p.client.clips.get(c.id)).playback_url;
  const play = async (c: Clip) => {
    setMsg("");
    try {
      const url = await fresh(c);
      if (!url) throw new Error("This clip has nothing to play.");
      setPlaying({ clip: c, url });
    } catch (e) {
      setMsg(errorText(e));
    }
  };
  const download = async (c: Clip) => {
    setBusy(c.id);
    setMsg("");
    try {
      const url = await fresh(c);
      if (!url) throw new Error("This clip has nothing to download.");
      await downloadClip(url, `${(c.title || "clip").replace(/[^\w.-]+/g, "-")}-${c.from.slice(0, 19).replace(/[:T]/g, "")}.mp4`);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const title = (c: Clip) => c.title || `Clip from ${name(c.source_id)}`;
  if (!clips.length) return <p className="adm-card adm-empty">No saved clips yet. Save one from a camera's playback.</p>;
  return (
    <>
      {msg && <p role="alert" className="adm-error" style={{ marginBottom: 10 }}>{msg}</p>}
      <div className="adm-table-wrap">
        <table className="adm-table" style={{ minWidth: 720 }}>
          <thead><tr><th scope="col">Clip</th><th scope="col">Camera</th><th scope="col">Length</th><th scope="col">Kept</th><th scope="col"><span className="adm-sr">Actions</span></th></tr></thead>
          <tbody>
            {clips.map((c) => (
              <tr key={c.id}>
                <td><span className="adm-col"><span>{title(c)}</span><span className="adm-small adm-muted">{dayLabel(c.from)} {fmtHm(c.from)}–{fmtHm(c.to)}</span></span></td>
                <td className="adm-soft">{name(c.source_id)}</td>
                <td className="adm-mono adm-soft adm-small">{fmtDuration(c.duration_ms)}</td>
                <td className="adm-soft">Until deleted</td>
                <td className="adm-actions">
                  <button type="button" className="adm-btn adm-btn-sm adm-btn-ghost" onClick={() => void play(c)} aria-label={`Play ${title(c)}`}>Play</button>
                  <button type="button" className="adm-btn adm-btn-sm adm-btn-ghost" disabled={busy === c.id} onClick={() => void download(c)} aria-label={`Download ${title(c)}`}>{busy === c.id ? "Preparing…" : "Download"}</button>
                  <button type="button" className="adm-btn adm-btn-sm adm-btn-danger" disabled={!canDelete} onClick={() => setDeleting(c)} aria-label={`Delete ${title(c)}`}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {playing && (
        <Dialog title={title(playing.clip)} onClose={() => setPlaying(null)} wide>
          <div className="adm-shot" style={{ borderRadius: 8 }}><HlsVideo url={playing.url} label={title(playing.clip)} /></div>
        </Dialog>
      )}
      {deleting && (
        <Confirm title="Delete this clip?" action="Delete clip" body={<>“{title(deleting)}” is deleted for good.</>} onClose={() => setDeleting(null)}
          onConfirm={async () => { await p.client.clips.delete(deleting.id); onDeleted(deleting.id); }} />
      )}
    </>
  );
}
