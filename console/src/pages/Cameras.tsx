// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Cameras and sensors: a grid of latest frames (or readings) or a table, with
// status filters and a name/place filter.
import { useEffect, useMemo, useState } from "react";
import type { Event, Source } from "senseplane";
import { Link } from "../router";
import { prefs } from "../session";
import { useApp } from "../shell/AppData";
import {
  noVideoSince,
  type StatusKind, ago, eventKind, formatReading, ingestLabel, isSensor, isVideo, keepsLabel, statusOf, timeOf,
} from "../shell/sources";
import { EmptyState, Frame, Icon, LinkButton, PageHeader, Pill, StatusDot, Table, Tag } from "../ui";
import "./cameras.css";

type Filter = "all" | StatusKind;
type Now = { snapshot_url?: string; captured_at: string; readings?: { sense: string; value: number; unit: string; measured_at?: string }[] };

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "on", label: "Online" },
  { id: "attention", label: "Needs attention" },
  { id: "waiting", label: "Waiting" },
  { id: "paused", label: "Paused" },
];

/** Latest frame or reading per source, refreshed every 30 s. */
function useLatest(sources: Source[]) {
  const { client } = useApp();
  const [now, setNow] = useState<Record<string, Now>>({});
  const ids = sources.map((s) => s.id).join(",");
  useEffect(() => {
    let live = true;
    const load = () => {
      for (const s of sources) {
        void client.sources.now(s.id).then((n) => live && setNow((all) => ({ ...all, [s.id]: n as Now }))).catch(() => undefined);
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [ids, client]); // eslint-disable-line react-hooks/exhaustive-deps
  return now;
}

/** The most recent event per source from one page of recent events. */
function useLastEvents() {
  const { extra } = useApp();
  const [last, setLast] = useState<Record<string, Event>>({});
  useEffect(() => {
    let live = true;
    void extra.eventsPage({ from: new Date(Date.now() - 7 * 86400_000).toISOString(), limit: "100" }).then((p) => {
      if (!live) return;
      const m: Record<string, Event> = {};
      for (const e of p.data) if (!m[e.source.id] || Date.parse(e.occurred_at) > Date.parse(m[e.source.id]!.occurred_at)) m[e.source.id] = e;
      setLast(m);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [extra]);
  return last;
}

function lastText(s: Source, e: Event | undefined): string {
  const down = noVideoSince(s);
  if (down) return down;
  if (e) return `${eventKind(e.type)}, ${ago(e.occurred_at)}`;
  return statusOf(s).kind === "waiting" ? "Not connected yet" : "No events yet";
}

function CameraCard({ s, now, last, index }: { s: Source; now?: Now; last?: Event; index: number }) {
  const st = statusOf(s);
  const reading = now?.readings?.[0];
  return (
    <Link to={`/cameras/${s.id}`} className="cam-card">
      {isVideo(s) ? (
        <Frame src={st.kind === "on" ? now?.snapshot_url : undefined} alt={`Latest frame from ${s.name}`} variant={index} className="cam-card-frame">
          <span className="frame-label bl">{st.kind === "on" ? `LATEST FRAME · ${timeOf(now?.captured_at ?? Date.now())}` : st.label.toUpperCase()}</span>
          <span className="frame-label tr">{ingestLabel(s)}</span>
        </Frame>
      ) : (
        <div className="cam-card-reading">
          <span className="reading-value">{reading ? formatReading(reading) : "—"}</span>
          <span className="reading-meta">{ingestLabel(s)}{reading?.measured_at ? ` · ${timeOf(reading.measured_at, false)}` : ""}</span>
        </div>
      )}
      <div className="cam-card-body">
        <span className="cam-card-title">
          <span className="cam-card-name"><StatusDot tone={st.tone} />{s.name}</span>
          <span className={`cam-status cam-status-${st.kind}`}>{st.label}</span>
        </span>
        <span className="cam-card-meta">{[s.location, lastText(s, last)].filter(Boolean).join(" · ")}</span>
        <span className="cam-card-tags">{s.senses.map((x) => <Tag key={x}>{x}</Tag>)}</span>
      </div>
    </Link>
  );
}

export function CamerasPage() {
  const { sources, account } = useApp();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [view, setViewState] = useState<"grid" | "list">(() => prefs.get("camerasView", "grid"));
  const setView = (v: "grid" | "list") => { setViewState(v); prefs.set("camerasView", v); };
  const all = sources ?? [];
  const now = useLatest(all);
  const last = useLastEvents();

  useEffect(() => { document.title = "Cameras · Senseplane"; }, []);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: all.length, on: 0, attention: 0, waiting: 0, paused: 0 };
    for (const s of all) c[statusOf(s).kind]++;
    return c;
  }, [all]);
  const needle = q.trim().toLowerCase();
  const shown = all.filter((s) =>
    (filter === "all" || statusOf(s).kind === filter) &&
    (!needle || s.name.toLowerCase().includes(needle) || (s.location ?? "").toLowerCase().includes(needle)));
  const cams = all.filter(isVideo).length;
  const sensors = all.filter(isSensor).length;
  const title = `${cams} camera${cams === 1 ? "" : "s"}${sensors ? `, ${sensors} sensor${sensors === 1 ? "" : "s"}` : ""}`;

  return (
    <div className="page page-narrow">
      <PageHeader eyebrow="Cameras and sensors" title={sources ? title : "Cameras"} actions={<LinkButton to="/cameras/new" variant="primary" icon="plus">Add camera</LinkButton>} />

      {sources && all.length === 0 ? (
        <EmptyState icon="camera" title="No cameras yet" actions={<LinkButton to="/cameras/new" variant="primary" icon="plus">Add camera</LinkButton>}>
          Use a phone, an IP camera, OBS or Home Assistant sensors. It takes a minute.
        </EmptyState>
      ) : (
        <>
          <div className="cams-toolbar">
            <div role="group" aria-label="Filter by status" className="cams-filters">
              {FILTERS.filter((f) => f.id === "all" || f.id === "on" || f.id === "attention" || counts[f.id] > 0).map((f) => (
                <Pill key={f.id} pressed={filter === f.id} count={counts[f.id]} onClick={() => setFilter(f.id)}>{f.label}</Pill>
              ))}
            </div>
            <div className="cams-tools">
              <label className="search-box">
                <Icon name="search" size={14} />
                <input type="search" placeholder="Filter by name or place" aria-label="Filter cameras" value={q} onChange={(e) => setQ(e.target.value)} />
              </label>
              <div role="group" aria-label="Layout" className="segmented">
                <button type="button" aria-label="Grid" aria-pressed={view === "grid"} onClick={() => setView("grid")}><Icon name="grid" size={15} /></button>
                <button type="button" aria-label="List" aria-pressed={view === "list"} onClick={() => setView("list")}><Icon name="list" size={15} /></button>
              </div>
            </div>
          </div>

          {sources && shown.length === 0 && <p className="muted">Nothing matches this filter.</p>}

          {view === "grid" ? (
            <div className="cam-grid">
              {shown.map((s, i) => <CameraCard key={s.id} s={s} now={now[s.id]} last={last[s.id]} index={i} />)}
            </div>
          ) : (
            <Table label="Cameras and sensors" minWidth={820}>
              <thead>
                <tr>
                  <th scope="col">Name</th><th scope="col">Status</th><th scope="col">Senses</th>
                  <th scope="col">Connected by</th><th scope="col">Keeps</th><th scope="col">Last event</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const st = statusOf(s);
                  return (
                    <tr key={s.id}>
                      <td><Link to={`/cameras/${s.id}`} className="cam-row-name"><span>{s.name}</span>{s.location && <span className="muted cam-row-place">{s.location}</span>}</Link></td>
                      <td><span className={`cam-status cam-status-${st.kind} cam-row-status`}><StatusDot tone={st.tone} />{st.label}</span></td>
                      <td className="mono cam-row-senses">{s.senses.join(", ")}</td>
                      <td className="cam-row-soft">{ingestLabel(s)}</td>
                      <td className="cam-row-soft">{keepsLabel(s, account)}</td>
                      <td className="muted">{lastText(s, last[s.id])}</td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </>
      )}
    </div>
  );
}
