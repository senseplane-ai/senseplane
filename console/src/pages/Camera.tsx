// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Camera detail (ADR 0046): recorded playback with today's timeline, Right now,
// Ask this camera, its watches, and tabs for events, privacy masks and settings.
import { useEffect, useState } from "react";
import type { Event, Source } from "senseplane";
import { Link, useLocation } from "../router";
import { useApp } from "../shell/AppData";
import { ingestLong, isVideo, keepsLabel, noVideoSince, startOfToday, statusOf } from "../shell/sources";
import { EmptyState, LinkButton, StatusDot, Tabs, tabPanelProps } from "../ui";
import { CameraActions } from "./camera/Actions";
import { AskCamera, CameraWatches, RightNow } from "./camera/Aside";
import { EventsTab } from "./camera/EventsTab";
import { Playback } from "./camera/Playback";
import { SensorPanel } from "./camera/SensorPanel";
import { SettingsTab } from "./camera/SettingsTab";
import { ZoneEditor } from "./camera/ZoneEditor";
import "./camera/camera.css";

type Tab = "events" | "masks" | "settings";

/** The source from the shared list, else fetched once (deep links before the list loads). */
function useSource(id: string): { source: Source | null; missing: boolean } {
  const { sources, client, putSource } = useApp();
  const listed = sources?.find((s) => s.id === id) ?? null;
  const [fetched, setFetched] = useState<Source | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (listed || sources === null) return;
    let live = true;
    client.sources.get(id).then((s) => { if (live) { setFetched(s); putSource(s); } }).catch(() => live && setMissing(true));
    return () => { live = false; };
  }, [id, listed, sources, client, putSource]);
  return { source: listed ?? fetched, missing };
}

export function CameraPage({ id }: { id: string }) {
  const { client, account, putSource } = useApp();
  const { search } = useLocation();
  const { source, missing } = useSource(id);
  const [tab, setTab] = useState<Tab>("events");
  const [events, setEvents] = useState<Event[] | null>(null);
  const t = search.get("t");
  const initialAt = t && !Number.isNaN(Date.parse(t)) ? Date.parse(t) : undefined;

  useEffect(() => {
    if (source) document.title = `${source.name} · Senseplane`;
  }, [source?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    const load = async () => {
      const out: Event[] = [];
      try {
        for await (const e of client.events.list({ source: id, from: new Date(startOfToday()).toISOString() })) {
          out.push(e);
          if (out.length >= 200) break;
        }
      } catch {
        /* keep what loaded; the tab shows its empty state */
      }
      if (live) setEvents(out.sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)));
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [client, id]);

  if (!source) {
    return (
      <div className="page page-narrow">
        <nav aria-label="Breadcrumb" className="cam-crumb"><Link to="/cameras">Cameras</Link></nav>
        {missing
          ? <EmptyState icon="camera" title="Camera not found" actions={<LinkButton to="/cameras" variant="primary">Back to cameras</LinkButton>}>It may have been removed, or this key can&apos;t see it.</EmptyState>
          : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const st = statusOf(source);
  const video = isVideo(source);
  const res = (source as Source & { max_resolution?: string }).max_resolution;
  const facts = [
    source.location, ingestLong(source), video ? res : undefined,
    video ? (source.record_audio ? "Audio recorded" : "Audio not recorded") : undefined,
    `Keeps ${keepsLabel(source, account)}`.replace("Keeps Until", "Keeps until"),
  ].filter(Boolean) as string[];
  const tabs: { id: Tab; label: string }[] = video
    ? [{ id: "events", label: "Events" }, { id: "masks", label: "Privacy masks" }, { id: "settings", label: "Settings" }]
    : [{ id: "events", label: "Events" }, { id: "settings", label: "Settings" }];

  return (
    <div className="page page-narrow cam-page">
      <nav aria-label="Breadcrumb" className="cam-crumb">
        <Link to="/cameras">Cameras</Link> <span aria-hidden="true">/</span> <span aria-current="page">{source.name}</span>
      </nav>

      <header className="page-header cam-header">
        <div className="page-header-text">
          <h1 className="page-title">{source.name}</h1>
          <span className="cam-facts">
            <span className="cam-status"><StatusDot tone={st.tone} halo />{st.label}</span>
            {noVideoSince(source) && <span className="cam-fact"><span aria-hidden="true">·</span>{noVideoSince(source)}</span>}
            {facts.map((f) => (
              <span key={f} className="cam-fact"><span aria-hidden="true">·</span>{f}</span>
            ))}
          </span>
        </div>
        <CameraActions source={source} />
      </header>

      {(source as Source & { view_changed_at?: string | null }).view_changed_at && (
        <p role="alert" className="notice notice-warn">
          The view has changed since the privacy masks were drawn.{" "}
          <button type="button" className="link-btn" onClick={() => setTab("masks")}>Check your masks</button>
        </p>
      )}

      <div className="cam-main">
        <div className="cam-left">
          {video ? <Playback source={source} events={events ?? []} initialAt={initialAt} /> : <SensorPanel source={source} />}
        </div>
        <aside aria-label="About this camera" className="cam-aside">
          <RightNow source={source} />
          {video && <AskCamera source={source} />}
          <CameraWatches source={source} events={events ?? []} />
        </aside>
      </div>

      <Tabs label="Camera sections" tabs={tabs} value={tab} onChange={setTab} idPrefix="cam" />
      <div {...tabPanelProps(tab, "cam")}>
        {tab === "events" && <EventsTab events={events ?? []} loading={events === null} />}
        {tab === "masks" && video && <ZoneEditor client={client} source={source} onSaved={putSource} />}
        {tab === "settings" && <SettingsTab key={source.id} source={source} />}
      </div>
    </div>
  );
}
