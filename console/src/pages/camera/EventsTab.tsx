// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { Event } from "senseplane";
import { Link } from "../../router";
import { EmptyState, Frame } from "../../ui";
import { clock } from "./time";

function confidence(e: Event): string {
  const c = e.confidence == null ? "" : e.confidence.toFixed(2);
  if (e.type === "watch.triggered" && e.verified) return c ? `Verified · ${c}` : "Verified";
  if (e.type === "watch.triggered" && e.verified === false) return "Not verified";
  return c;
}

/** This camera's recent events, newest first; each row opens it in Events. */
export function EventsTab({ events, loading }: { events: Event[]; loading: boolean }) {
  if (loading) return <p className="muted">Loading events…</p>;
  if (!events.length) {
    return <EmptyState icon="events" title="No events today">Detections, sounds and watches that fire on this camera show up here.</EmptyState>;
  }
  return (
    <ul className="cam-events">
      {events.slice(0, 50).map((e) => (
        <li key={e.id}>
          <Link to={`/events?event=${e.id}`} className="cam-event">
            <span className="cam-event-time mono">{clock(Date.parse(e.occurred_at), true)}</span>
            <Frame src={e.media.snapshot_url} alt="" className="cam-event-thumb" />
            <span className="cam-event-text">
              <span>{e.summary}</span>
              <span className={e.type === "watch.triggered" ? "cam-event-type live-text" : "cam-event-type"}>{e.type}</span>
            </span>
            <span className="cam-event-conf">{confidence(e)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
