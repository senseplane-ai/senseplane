// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Sensors have no video: show the latest reading per sense and device, with
// today's trend for numbers, since when for states (open, on) and how many
// times for events (doorbell, button). ADR 0060.
import { useEffect, useState } from "react";
import { type Source, stateWord } from "senseplane";
import { useApp } from "../../shell/AppData";
import { type Reading, formatReading, readingKey, readingLabel, startOfToday } from "../../shell/sources";
import { EmptyState } from "../../ui";
import { clock } from "./time";

type Point = Reading & { value: number };

function Sparkline({ points, label }: { points: Point[]; label: string }) {
  if (points.length < 2) return null;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * 100},${30 - ((p.value - min) / span) * 26 - 2}`).join(" ");
  return (
    <svg className="cam-spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={label}>
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const at = (r: Reading) => Date.parse(r.measured_at ?? "");
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

/** "Opened 3 times today", "On twice today": how often a state turned true. */
function changes(rows: Reading[]): number {
  let n = 0;
  rows.forEach((r, i) => { if (r.value === true && rows[i - 1]?.value !== true) n += 1; });
  return n;
}

function Tile({ rows }: { rows: Reading[] }) {
  const last = rows[rows.length - 1]!;
  const name = readingLabel(last);
  const kind = last.kind ?? "number";
  let note: string | undefined;
  if (kind === "state") {
    const on = stateWord(last.sense, true);
    const n = changes(rows);
    note = n ? `${on} ${times(n)} today` : undefined;
  } else if (kind === "event") {
    note = `${times(rows.length)} today`;
  }
  return (
    <div className="card cam-sensor">
      <span className="eyebrow">{name}</span>
      <span className="cam-sensor-value">{formatReading(last)}</span>
      {last.measured_at && (
        <span className="cam-mono-note">
          {kind === "state" ? `SINCE ${clock(Date.parse(last.since ?? last.measured_at))}` : kind === "event" ? `LAST AT ${clock(at(last))}` : `AT ${clock(at(last))}`}
        </span>
      )}
      {note && <span className="muted">{note[0]!.toUpperCase() + note.slice(1)}</span>}
      {kind === "number" && (
        <Sparkline points={rows as Point[]} label={`${name} today, from ${formatReading(rows[0]!)} to ${formatReading(last)}`} />
      )}
    </div>
  );
}

export function SensorPanel({ source }: { source: Source }) {
  const { client } = useApp();
  const [history, setHistory] = useState<Reading[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => client.sources.history(source.id, { from: new Date(startOfToday()).toISOString() })
      .then((h) => live && setHistory((h as { data: Reading[] }).data))
      .catch(() => live && setHistory([]));
    void load();
    const t = setInterval(load, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [client, source.id]);

  if (history === null) return <p className="muted">Loading readings…</p>;
  if (!history.length) return <EmptyState icon="usage" title="No readings today">Readings appear here as soon as the sensor reports.</EmptyState>;
  const keys = [...new Set(history.map(readingKey))];
  return (
    <section aria-label="Readings" className="cam-sensors">
      {keys.map((k) => <Tile key={k} rows={history.filter((r) => readingKey(r) === k).sort((a, b) => at(a) - at(b))} />)}
    </section>
  );
}
