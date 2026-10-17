// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Sensors have no video: show the latest reading per sense and today's trend.
import { useEffect, useState } from "react";
import type { Source } from "senseplane";
import { useApp } from "../../shell/AppData";
import { formatReading, startOfToday } from "../../shell/sources";
import { EmptyState } from "../../ui";
import { clock } from "./time";

type Reading = { sense: string; value: number; unit: string; measured_at?: string };

function Sparkline({ points, label }: { points: Reading[]; label: string }) {
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
  const senses = [...new Set(history.map((r) => r.sense))];
  return (
    <section aria-label="Readings" className="cam-sensors">
      {senses.map((sense) => {
        const rows = history.filter((r) => r.sense === sense)
          .sort((a, b) => Date.parse(a.measured_at ?? "") - Date.parse(b.measured_at ?? ""));
        const last = rows[rows.length - 1]!;
        return (
          <div key={sense} className="card cam-sensor">
            <span className="eyebrow">{sense}</span>
            <span className="cam-sensor-value">{formatReading(last)}</span>
            {last.measured_at && <span className="cam-mono-note">AT {clock(Date.parse(last.measured_at))}</span>}
            <Sparkline points={rows} label={`${sense} today, from ${formatReading(rows[0]!)} to ${formatReading(last)}`} />
          </div>
        );
      })}
    </section>
  );
}
