// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Stories and following (ADR 0070). A story is one video from many moments
// across cameras, in time order, never re-encoded: each piece captioned with its camera and time.
// Build one from events picked on the Events page (?events=…) and time
// ranges added here, play it, and share a signed link. Following an object
// or a pet (started from an event's snapshot) shows its route here (?follow=…).
import { useEffect, useMemo, useState } from "react";
import type { Follow, Story } from "senseplane";
import { useLocation } from "../../router";
import { errorText, unavailable } from "./api";
import {
  type PageProps, Confirm, CopyButton, ErrorNote, Header, HlsVideo, Tabs, Unavailable, can, ctxOf, fmtDuration, fmtHm, fmtTime,
  useInterval, useLoad, useRole, useSources,
} from "./kit";

type Moment = { event: string; label: string } | { source: string; from: string; to: string; label: string };
const POLL_MS = 3000;
const busy = (s: { status: string }) => s.status === "queued" || s.status === "rendering" || s.status === "running";

/** The console's player page for a signed link, for sending to a person. */
export const shareLink = (url: string, origin = typeof location !== "undefined" ? location.origin : "") => `${origin}/play.html#u=${encodeURIComponent(url)}`;

export function StoriesPage(p: PageProps) {
  const { search } = useLocation();
  const { role } = useRole(ctxOf(p));
  const sources = useSources(p);
  const cameras = useMemo(() => new Map(sources.list.filter((s) => s.type !== "sensor").map((s) => [s.id, s])), [sources.list]);
  const [tab, setTab] = useState<"stories" | "follows">(search.get("follow") ? "follows" : "stories");
  const stories = useLoad(() => p.client.stories.list(), [p.apiUrl, p.apiKey]);
  const follows = useLoad(() => p.client.follows.list(), [p.apiUrl, p.apiKey]);
  const [storyId, setStoryId] = useState<string | null>(search.get("id"));
  const [followId, setFollowId] = useState<string | null>(search.get("follow"));
  useInterval(() => {
    if (stories.data?.some(busy)) void stories.reload();
    if (follows.data?.some(busy)) void follows.reload();
  }, (stories.data?.some(busy) || follows.data?.some(busy)) ? POLL_MS : null);

  if (stories.missing) return <div className="adm"><Header eyebrow="Stories" title="Stories" /><Unavailable what="Stories" /></div>;
  const pickStory = (id: string) => {
    setTab("stories");
    setStoryId(id);
  };
  return (
    <div className="adm adm-tight">
      <Header eyebrow="Stories" title="One video from many moments, across cameras" />
      <Tabs label="Stories or follows" value={tab} onChange={setTab} tabs={[{ id: "stories", label: "Stories" }, { id: "follows", label: "Followed objects" }]} />
      {tab === "stories" ? (
        <>
          {can.clips(role) && <Builder p={p} names={cameras} initial={search.get("events")} onMade={(s) => { stories.setData((d) => [s, ...(d ?? [])]); setStoryId(s.id); }} />}
          <div className="adm-split">
            <section aria-label="Story list" className="adm-card adm-ev-list" aria-busy={stories.loading}>
              {(stories.data ?? []).map((s) => (
                <button key={s.id} type="button" className="adm-ev" aria-pressed={storyId === s.id} onClick={() => setStoryId(s.id)}>
                  <span className="adm-ev-time">{fmtTime(s.created_at)}</span>
                  <span className="adm-col" style={{ gap: 3 }}>
                    <span>{s.title ?? `${s.pieces.length} moments`}</span>
                    <span className="adm-ev-meta">
                      <span className={s.status === "ready" ? "adm-pill adm-pill-watch" : s.status === "failed" ? "adm-pill adm-pill-alert" : "adm-pill"}>{s.status}</span>
                      {[...new Set(s.pieces.map((x) => x.source_name))].join(", ")}
                    </span>
                  </span>
                </button>
              ))}
              {!stories.loading && !stories.data?.length && <p className="adm-empty">{stories.error ? errorText(stories.error) : "No stories yet. Pick events on the Events page, or add time ranges above."}</p>}
            </section>
            {storyId ? <StoryDetail key={storyId} p={p} id={storyId} canDelete={can.clips(role)} onDeleted={() => { stories.setData((d) => d?.filter((x) => x.id !== storyId)); setStoryId(null); }} />
              : <section aria-label="Story" className="adm-card adm-ev-detail"><p className="adm-empty">Pick a story to play it.</p></section>}
          </div>
        </>
      ) : (
        <div className="adm-split">
          <section aria-label="Follow list" className="adm-card adm-ev-list" aria-busy={follows.loading}>
            {(follows.data ?? []).map((f) => (
              <button key={f.id} type="button" className="adm-ev" aria-pressed={followId === f.id} onClick={() => setFollowId(f.id)}>
                <span className="adm-ev-time">{fmtTime(f.created_at)}</span>
                <span className="adm-col" style={{ gap: 3 }}>
                  <span>{followLabel(f)}</span>
                  <span className="adm-ev-meta"><span className={f.status === "done" ? "adm-pill adm-pill-watch" : f.status === "queued" || f.status === "running" ? "adm-pill" : "adm-pill adm-pill-alert"}>{f.status}</span>{fmtHm(f.from)}–{fmtHm(f.to)}</span>
                </span>
              </button>
            ))}
            {!follows.loading && !follows.data?.length && <p className="adm-empty">{follows.error ? errorText(follows.error) : "Nothing followed yet. Open an event and choose “Follow this”."}</p>}
          </section>
          {followId ? <FollowDetail key={followId} p={p} id={followId} onStory={pickStory} />
            : <section aria-label="Route" className="adm-card adm-ev-detail"><p className="adm-empty">Pick one to see its route.</p></section>}
        </div>
      )}
    </div>
  );
}

const followLabel = (f: Follow) => {
  const r = f.reference as { description?: string; label?: string };
  return r.description ?? (r.label ? `A ${r.label}` : "An object");
};

/** Moments for a new story: events passed in from the Events page, and time ranges added here. */
function Builder({ p, names, initial, onMade }: { p: PageProps; names: Map<string, { name: string }>; initial: string | null; onMade: (s: Story) => void }) {
  const [moments, setMoments] = useState<Moment[]>([]);
  const [title, setTitle] = useState("");
  const [fast, setFast] = useState(false);
  const [range, setRange] = useState({ source: "", from: "", to: "" });
  const [error, setError] = useState<unknown>();
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const ids = (initial ?? "").split(",").filter(Boolean);
    if (!ids.length) return;
    let live = true;
    void Promise.all(ids.map((id) => p.client.events.get(id).then((e) => ({ event: id, label: `${fmtTime(e.occurred_at)} · ${e.summary}` }), () => ({ event: id, label: id }))))
      .then((m) => live && setMoments(m));
    return () => { live = false; };
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const cams = useMemo(() => [...names].map(([id, s]) => ({ id, name: s.name })), [names]);
  const addRange = () => {
    if (!range.source || !range.from || !range.to) return;
    const from = new Date(range.from).toISOString();
    const to = new Date(range.to).toISOString();
    setMoments((m) => [...m, { source: range.source, from, to, label: `${names.get(range.source)?.name ?? range.source} · ${fmtTime(from)}–${fmtHm(to)}` }]);
    setRange({ ...range, from: "", to: "" });
  };
  const make = async () => {
    setWorking(true);
    setError(undefined);
    try {
      const s = await p.client.stories.create({
        moments: moments.map((m) => ("event" in m ? { event: m.event } : { source: m.source, from: m.from, to: m.to })),
        ...(title.trim() ? { title: title.trim() } : {}), ...(fast ? { mode: "fast" as const } : {}),
      });
      setMoments([]);
      setTitle("");
      onMade(s);
    } catch (e) {
      setError(e);
    } finally {
      setWorking(false);
    }
  };
  return (
    <section aria-label="New story" className="adm-card" style={{ padding: 16, marginBottom: 16 }}>
      <div className="adm-stack">
        <div className="adm-row">
          <label className="adm-label"><span>Camera</span>
            <select className="adm-select" value={range.source} onChange={(e) => setRange({ ...range, source: e.target.value })}>
              <option value="">Choose…</option>
              {cams.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="adm-label"><span>From</span><input className="adm-input" type="datetime-local" step="1" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="adm-label"><span>To</span><input className="adm-input" type="datetime-local" step="1" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          <button type="button" className="adm-btn" onClick={addRange} disabled={!range.source || !range.from || !range.to}>Add range</button>
        </div>
        {moments.length > 0 && (
          <ol className="adm-small" aria-label="Moments in this story" style={{ paddingLeft: 18 }}>
            {moments.map((m, i) => (
              <li key={i}>{m.label} <button type="button" className="adm-btn adm-btn-ghost adm-btn-sm" onClick={() => setMoments((x) => x.filter((_, j) => j !== i))} aria-label={`Remove ${m.label}`}>Remove</button></li>
            ))}
          </ol>
        )}
        <div className="adm-row">
          <label className="adm-label"><span>Title</span><input className="adm-input" value={title} maxLength={200} placeholder="How the cat got out" onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="adm-row adm-small"><input type="checkbox" checked={fast} onChange={(e) => setFast(e.target.checked)} />Fast (no captions or downloads)</label>
          <span className="adm-grow" />
          <button type="button" className="adm-btn adm-btn-primary" disabled={!moments.length || working} onClick={() => void make()}>
            {working ? "Making…" : `Make story${moments.length ? ` of ${moments.length}` : ""}`}
          </button>
        </div>
        <p className="adm-small adm-muted">Pieces go in time order, captioned with camera and time; a gap over a minute is said in the next caption. Nothing is re-encoded. At most 20 pieces and 10 minutes.</p>
        <ErrorNote error={error} />
      </div>
    </section>
  );
}

function StoryDetail({ p, id, canDelete, onDeleted }: { p: PageProps; id: string; canDelete: boolean; onDeleted: () => void }) {
  const story = useLoad(() => p.client.stories.get(id), [id]);
  const [share, setShare] = useState<{ url: string; expires_at: string } | null>(null);
  const [shareError, setShareError] = useState<unknown>();
  const [confirm, setConfirm] = useState(false);
  useInterval(() => void story.reload(), story.data && busy(story.data) ? POLL_MS : null);
  const s = story.data;
  if (!s) return <section aria-label="Story" className="adm-card adm-ev-detail"><p className="adm-empty">{story.error ? errorText(story.error) : "Loading…"}</p></section>;
  const makeLink = async () => {
    setShareError(undefined);
    try {
      setShare(await p.client.stories.link(s.id, 86_400));
    } catch (e) {
      setShareError(e);
    }
  };
  return (
    <section aria-label="Story" className="adm-card adm-ev-detail">
      <div className="adm-shot">
        {s.status === "ready" && s.playback_url ? <HlsVideo url={s.playback_url} label={`Story: ${s.title ?? s.id}`} {...(s.captions_url ? { captions: s.captions_url } : {})} />
          : <p className="adm-empty" role="status">{s.status === "failed" ? `This story could not be made: ${s.error ?? "it failed"}.` : "Making the video…"}</p>}
      </div>
      <div className="adm-stack" style={{ padding: 16 }}>
        <h2 style={{ fontSize: 17, fontWeight: 500 }}>{s.title ?? "Story"}</h2>
        <span className="adm-muted" style={{ fontSize: 13 }}>
          {s.mode === "fast" ? "Fast (no captions)" : "With captions"}{s.duration_ms ? ` · ${fmtDuration(s.duration_ms)}` : ""}{s.has_audio ? " · with sound" : ""}
        </span>
        <ol aria-label="Pieces" className="adm-small" style={{ paddingLeft: 18 }}>
          {s.pieces.map((x, i) => (
            <li key={i}>
              {x.gap_before_ms ? <span className="adm-muted">{fmtDuration(x.gap_before_ms)} later · </span> : null}
              <strong>{x.source_name}</strong> {fmtTime(x.from)}–{fmtHm(x.to)}
              {x.recorded_ms === 0 ? <span className="adm-retry"> · nothing recorded</span> : null}
              {!x.audio ? <span className="adm-muted"> · no sound</span> : null}
            </li>
          ))}
        </ol>
        {s.note && <p className="adm-small adm-muted" role="note">{s.note}</p>}
        {s.parts && s.parts.length > 0 && (
          <div className="adm-row" aria-label="Downloads">
            {s.parts.map((x, i) => x.download_url && (
              <a key={i} className="adm-btn adm-btn-sm" href={x.download_url} download>{s.parts!.length > 1 ? `Download part ${i + 1} (MP4)` : "Download (MP4)"}</a>
            ))}
          </div>
        )}
        {s.status === "ready" && (
          <div className="adm-row">
            <button type="button" className="adm-btn" onClick={() => void makeLink()}>Share link</button>
            {share && <><code className="adm-mono adm-small" style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280 }}>{shareLink(share.url)}</code><CopyButton text={shareLink(share.url)} label="Copy link" /><span className="adm-small adm-muted">until {fmtTime(share.expires_at)}</span></>}
          </div>
        )}
        <ErrorNote error={shareError} />
        {canDelete && <div className="adm-row"><button type="button" className="adm-btn adm-btn-ghost" onClick={() => setConfirm(true)}>Delete story</button></div>}
        {confirm && (
          <Confirm title="Delete this story?" body="Its video is deleted; shared links stop working. The recordings are not touched." action="Delete"
            onClose={() => setConfirm(false)} onConfirm={async () => { await p.client.stories.delete(s.id); onDeleted(); }} />
        )}
      </div>
    </section>
  );
}

function FollowDetail({ p, id, onStory }: { p: PageProps; id: string; onStory: (id: string) => void }) {
  const f = useLoad(() => p.client.follows.get(id), [id]);
  const [play, setPlay] = useState<string | null>(null);
  useInterval(() => void f.reload(), f.data && busy(f.data) ? POLL_MS : null);
  const d = f.data;
  if (!d) return <section aria-label="Route" className="adm-card adm-ev-detail"><p className="adm-empty">{f.error ? errorText(f.error) : "Loading…"}</p></section>;
  const r = d.result;
  const visit = r?.route?.find((v) => v.playback_url === play);
  return (
    <section aria-label="Route" className="adm-card adm-ev-detail">
      {visit?.playback_url && <div className="adm-shot"><HlsVideo url={visit.playback_url} label={`${visit.source_name} ${fmtHm(visit.from)}`} /></div>}
      <div className="adm-stack" style={{ padding: 16 }}>
        <h2 style={{ fontSize: 17, fontWeight: 500 }}>{followLabel(d)}</h2>
        <span className="adm-muted" style={{ fontSize: 13 }}>{fmtTime(d.from)}–{fmtHm(d.to)} · {d.frames_examined} frames looked at{d.model_calls ? ` · ${d.model_calls} AI checks` : ""}</span>
        {busy(d) && <p role="status" className="adm-small">Looking through the recordings…</p>}
        {d.status === "refused" || d.status === "failed" ? <p role="alert" className="adm-small adm-retry">{d.error}</p> : null}
        {r && (
          <ol aria-label="Where it was seen" className="adm-small" style={{ paddingLeft: 18 }}>
            {(r.route ?? []).map((v, i) => {
              const gap = r.gaps?.find((g) => g.to === v.from);
              return (
                <li key={i}>
                  {gap?.note ? <div className="adm-muted">{gap.note}</div> : null}
                  <strong>{v.source_name}</strong> {fmtTime(v.from)}–{fmtHm(v.to)} · {Math.round(v.confidence * 100)}%{v.confirmed_by_model ? " · checked by AI" : ""}
                  {v.playback_url && <button type="button" className="adm-btn adm-btn-ghost adm-btn-sm" onClick={() => setPlay(v.playback_url!)}>Play</button>}
                </li>
              );
            })}
            {!r.route?.length && <li>Not seen in the frames looked at.</li>}
          </ol>
        )}
        {d.story_id && <div className="adm-row"><button type="button" className="adm-btn" onClick={() => onStory(d.story_id!)}>Watch the story</button></div>}
        {r?.story_note && <p className="adm-small adm-muted">{r.story_note}</p>}
      </div>
    </section>
  );
}

/** Draw a box on a snapshot, pick a time window, and follow the thing (never a person). */
export function FollowDialog({ p, event, snapshotUrl, onClose }: { p: PageProps; event: { id: string; occurred_at: string }; snapshotUrl: string; onClose: () => void }) {
  const [box, setBox] = useState<[number, number, number, number] | null>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const [around, setAround] = useState(30);
  const [error, setError] = useState<unknown>();
  const [working, setWorking] = useState(false);
  const at = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1))), Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1)))];
  };
  const go = async () => {
    if (!box) return;
    setWorking(true);
    setError(undefined);
    const t = Date.parse(event.occurred_at);
    try {
      const f = await p.client.follows.create({ reference: { event: event.id, box }, from: new Date(t - around * 60_000).toISOString(), to: new Date(t + around * 60_000).toISOString() });
      onClose();
      p.navigate(`/stories?follow=${f.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setWorking(false);
    }
  };
  return (
    <div role="dialog" aria-label="Follow this" className="adm-card" style={{ padding: 16 }}>
      <p className="adm-small">Draw a box around the object or pet to follow. People can't be followed.</p>
      <div data-testid="follow-canvas" style={{ position: "relative", userSelect: "none", cursor: "crosshair" }}
        onMouseDown={(e) => { const [x, y] = at(e); setDrag([x, y]); setBox([x, y, x, y]); }}
        onMouseMove={(e) => { if (!drag) return; const [x, y] = at(e); setBox([Math.min(drag[0], x), Math.min(drag[1], y), Math.max(drag[0], x), Math.max(drag[1], y)]); }}
        onMouseUp={() => setDrag(null)}>
        <img src={snapshotUrl} alt="Snapshot to draw on" draggable={false} style={{ width: "100%", display: "block" }} />
        {box && <span aria-hidden="true" style={{ position: "absolute", left: `${box[0] * 100}%`, top: `${box[1] * 100}%`, width: `${(box[2] - box[0]) * 100}%`, height: `${(box[3] - box[1]) * 100}%`, border: "2px solid var(--live)" }} />}
      </div>
      <div className="adm-row" style={{ marginTop: 12 }}>
        <label className="adm-label"><span>Look</span>
          <select className="adm-select" value={around} onChange={(e) => setAround(Number(e.target.value))}>
            <option value={15}>15 minutes either side</option>
            <option value={30}>30 minutes either side</option>
            <option value={60}>An hour either side</option>
          </select>
        </label>
        <span className="adm-grow" />
        <button type="button" className="adm-btn adm-btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="adm-btn adm-btn-primary" disabled={!box || box[2] - box[0] < 0.01 || box[3] - box[1] < 0.01 || working} onClick={() => void go()}>{working ? "Starting…" : "Follow it"}</button>
      </div>
      {error !== undefined && <p role="alert" className="adm-small adm-retry">{unavailable(error) ? "Following isn't available on this server." : (error as { details?: { person?: boolean } }).details?.person ? (error as Error).message : errorText(error)}</p>}
    </div>
  );
}
