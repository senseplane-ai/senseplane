// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Today's activities on this camera (ADR 0057): what was there or what
// happened, from when to when and for how long, newest first, with a day
// strip of when people were in view.
import { useEffect, useState } from "react";
import { type Source, type components, labelName } from "senseplane";
import { errorText, isUnavailable } from "../../api/extra";
import { useApp } from "../../shell/AppData";
import { startOfToday } from "../../shell/sources";
import { EmptyState, Tag } from "../../ui";
import { clock, pct } from "./time";

type Activity = components["schemas"]["Activity"];

/** "45 s", "12 min", "1 h 25 min", "2 h". */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const total = Math.round(s / 60);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

const words = (s: string) => s.replaceAll("_", " ");
const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "Person in kitchen", "Crying", or the watch's instruction. */
export function activityWhat(a: Activity, watches: Map<string, string>): string {
  if (a.kind === "presence") return `${labelName(a.label)}${a.zone ? ` in ${words(a.zone)}` : ""}`;
  if (a.kind === "sound") return sentence(words(a.label));
  return watches.get(a.watch_id ?? a.label) ?? a.summary ?? "A watch";
}

function sub(a: Activity, watches: Map<string, string>): string {
  if (a.kind === "presence" && a.peak_count > 1) return `Up to ${a.peak_count} at once`;
  if (a.kind === "watch" && a.summary && watches.has(a.watch_id ?? a.label)) return a.summary;
  return "";
}

export function ActivityTab({ source }: { source: Source }) {
  const { client } = useApp();
  const [acts, setActs] = useState<Activity[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [watches, setWatches] = useState<Map<string, string>>(new Map());
  const dayStart = startOfToday();

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await client.activity.list({ source: source.id, from: new Date(startOfToday()).toISOString(), limit: 200 });
        if (!live) return;
        setActs([...r.data].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)));
        setError(null);
      } catch (e) {
        if (live) setError(e);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [client, source.id]);

  useEffect(() => {
    let live = true;
    void (async () => {
      const m = new Map<string, string>();
      try {
        for await (const w of client.watches.list()) m.set(w.id, w.instruction);
      } catch {
        /* fall back to each activity's summary */
      }
      if (live) setWatches(m);
    })();
    return () => { live = false; };
  }, [client]);

  if (error && !acts) {
    return isUnavailable(error)
      ? <EmptyState icon="events" title="Activity isn't available on this server yet">Update Senseplane to see how long things lasted.</EmptyState>
      : <EmptyState icon="events" title="Activity couldn't be loaded">{errorText(error)}</EmptyState>;
  }
  if (!acts) return <p className="muted">Loading activity…</p>;
  if (!acts.length) {
    return <EmptyState icon="events" title="No activity today">People, sounds and tracked watches on this camera show up here, with how long they lasted.</EmptyState>;
  }

  const now = Date.now();
  const people = acts.filter((a) => a.kind === "presence" && a.label === "person");
  return (
    <div className="cam-activity">
      {people.length > 0 && (
        <div className="cam-act-day card" role="img" aria-label={`People in view today: ${people.length === 1 ? "once" : `${people.length} times`}`}>
          <div className="cam-tl-legend"><span>People today</span></div>
          <div className="cam-act-strip">
            {people.map((a) => {
              const from = Date.parse(a.started_at);
              const to = a.ended_at ? Date.parse(a.ended_at) : now;
              return <div key={a.id} className="cam-act-seg" style={{ left: pct(from, dayStart), width: `calc(${pct(to, dayStart)} - ${pct(from, dayStart)})` }} />;
            })}
          </div>
          <div className="cam-tl-axis" aria-hidden="true"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
        </div>
      )}
      <ul className="cam-events">
        {acts.map((a) => {
          const from = Date.parse(a.started_at);
          const to = a.ended_at ? Date.parse(a.ended_at) : now;
          const secs = a.ongoing ? Math.max(a.duration_s, (now - from) / 1000) : a.duration_s;
          const instant = !a.ongoing && secs < 1;
          const detail = sub(a, watches);
          return (
            <li key={a.id} className="cam-act">
              <span className="cam-event-time mono">
                {clock(from)}{instant ? "" : <>–{a.ongoing ? <span className="live-text">now</span> : clock(to)}</>}
              </span>
              <span className="cam-event-text">
                <span>{activityWhat(a, watches)}</span>
                {detail && <span className="cam-sub">{detail}</span>}
              </span>
              <span className="cam-act-end">
                {a.checked && <Tag>Checked later</Tag>}
                {!instant && <span className="cam-event-conf">{durationText(secs)}{a.ongoing ? " so far" : ""}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
