// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Usage: this period's meters against the workspace's limits (from the quota
// provider; null means unlimited, the self-host default), a daily chart and a
// per-camera table. The plan card shows only when the deployment names a plan.
import { useState } from "react";
import { type AccountX, type Limits, type UsageX, getAccount, getUsage } from "./api";
import { type PageProps, Header, LoadState, ctxOf, fmtBytes, fmtNum, useLoad, useSources } from "./kit";

type Metric = "min" | "gb" | "checks" | "live";
const NO_LIMITS: Limits = { live_view: true, live_view_minutes: null, max_live_viewers: null, camera_minutes: null, storage_gb: null, ai_checks: null };

export function periodTitle(fromIso: string, toIso: string): string {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: "long" });
  // A period that starts on the 1st reads as the whole month.
  const end = from.getDate() === 1 && from.getMonth() === to.getMonth() ? new Date(from.getFullYear(), from.getMonth() + 1, 0) : to;
  return from.getMonth() === end.getMonth() ? `${from.getDate()} – ${end.getDate()} ${month(from)}` : `${from.getDate()} ${month(from)} – ${end.getDate()} ${month(end)}`;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

interface Meter { label: string; used: string; of: string; pct: number | null; note: string }

export function meters(u: UsageX, a: AccountX | undefined, now = new Date()): Meter[] {
  const l = a?.limits ?? NO_LIMITS;
  const pct = (used: number, limit: number | null) => (limit === null || limit <= 0 ? null : Math.min(100, (used / limit) * 100));
  const of = (limit: number | null, unit = "") => (limit === null ? "unlimited" : `${fmtNum(limit)}${unit}`);
  const from = new Date(u.period.from);
  const monthEnd = new Date(from.getFullYear(), from.getMonth() + 1, 0, 23, 59);
  const elapsed = Math.max(1, now.getTime() - from.getTime());
  const projected = (used: number, limit: number | null) =>
    limit ? `On track to use about ${Math.round(((used / elapsed) * (monthEnd.getTime() - from.getTime()) / limit) * 100)}% by the ${ordinal(monthEnd.getDate())}` : "This period so far";
  const s = a?.storage;
  const storedBytes = s ? (s.raw_bytes ?? 0) + (s.clip_bytes ?? 0) + (s.snapshot_bytes ?? 0) : null;
  const storedGb = storedBytes !== null ? storedBytes / 1e9 : (u.storage_gb_month ?? u.storage_gb_hours / 730);
  const byKind = u.ai_checks_by_kind ?? {};
  const watchChecks = byKind.verify ?? 0;
  const questions = (byKind.ask ?? 0) + (byKind.look ?? 0);
  const live = u.live_view_minutes ?? 0;
  return [
    { label: "Camera minutes", used: fmtNum(u.camera_minutes), of: of(l.camera_minutes), pct: pct(u.camera_minutes, l.camera_minutes), note: projected(u.camera_minutes, l.camera_minutes) },
    {
      label: "Storage", used: storedBytes !== null ? fmtBytes(storedBytes) : `${fmtNum(storedGb, 1)} GB`, of: of(l.storage_gb, " GB"), pct: pct(storedGb, l.storage_gb),
      note: a?.retention_mode === "fill" ? "Oldest recordings are removed when storage is full" : a?.retention_days ? `Oldest recordings are removed after ${a.retention_days} days` : "Recordings are kept until you delete them",
    },
    { label: "AI checks", used: fmtNum(u.ai_checks), of: of(l.ai_checks), pct: pct(u.ai_checks, l.ai_checks), note: `Watches ${fmtNum(watchChecks)} · questions ${fmtNum(questions)}` },
    l.live_view
      ? { label: "Live view", used: fmtNum(live), of: of(l.live_view_minutes, " min"), pct: pct(live, l.live_view_minutes), note: `Viewer-minutes${l.max_live_viewers ? ` · up to ${l.max_live_viewers} ${l.max_live_viewers === 1 ? "person" : "people"} at once` : ""}` }
      : { label: "Live view", used: "Off", of: "", pct: null, note: "Live view isn't included in this workspace" },
  ];
}

export function UsagePage(p: PageProps) {
  const ctx = ctxOf(p);
  const usage = useLoad(() => getUsage(ctx), [p.apiUrl, p.apiKey]);
  const account = useLoad(() => getAccount(ctx), [p.apiUrl, p.apiKey]);
  const sources = useSources(p);
  const [metric, setMetric] = useState<Metric>("min");

  return (
    <LoadState r={usage} what="Usage">
      {(u) => {
        const a = account.data;
        const days = u.by_day ?? [];
        const hasLive = days.some((d) => d.live_view_minutes !== undefined);
        const val = (d: (typeof days)[number]) => (metric === "min" ? d.camera_minutes ?? 0 : metric === "gb" ? (d.storage_gb_hours ?? 0) / 24 : metric === "checks" ? d.ai_checks ?? 0 : d.live_view_minutes ?? 0);
        const max = Math.max(1e-9, ...days.map(val));
        const labels: Record<Metric, string> = { min: "Camera minutes per day", gb: "Storage per day (GB)", checks: "AI checks per day", live: "Live view minutes per day" };
        const fmtVal = (v: number) => (metric === "gb" ? fmtNum(v, 1) : fmtNum(v));
        const dayFmt = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
        const today = new Date().toISOString().slice(0, 10);
        const peak = days.reduce((m, d) => (val(d) > val(m) ? d : m), days[0] ?? { day: "" });
        const byCam = Object.entries(u.camera_minutes_by_source ?? {}).sort((x, y) => y[1] - x[1]);
        const metrics: [Metric, string][] = [["min", "Minutes"], ["gb", "Storage"], ["checks", "AI checks"], ...(hasLive ? [["live", "Live view"] as [Metric, string]] : [])];
        return (
          <div className="adm">
            <Header eyebrow="Usage" title={periodTitle(u.period.from, u.period.to)}>
              {a?.plan_label && (
                <div className="adm-plan">
                  <span className="adm-col"><span style={{ fontWeight: 500 }}>{a.plan_label}</span><span className="adm-small adm-muted">The limits below come from your plan</span></span>
                </div>
              )}
            </Header>

            <section aria-label="Allowances" className="adm-meters">
              {meters(u, a).map((m) => (
                <div key={m.label} className="adm-card adm-meter">
                  <span className="adm-muted" style={{ fontSize: 13 }}>{m.label}</span>
                  <span className="adm-meter-val">{m.used}{m.of && <span className="adm-meter-of"> of {m.of}</span>}</span>
                  {m.pct !== null && (
                    <div className="adm-bar" data-high={m.pct >= 90} role="progressbar" aria-label={`${m.label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(m.pct)}>
                      <div style={{ width: `${m.pct}%` }} />
                    </div>
                  )}
                  <span className="adm-small adm-muted">{m.note}</span>
                </div>
              ))}
            </section>

            <section aria-labelledby="daily-h" className="adm-card adm-stack" style={{ padding: 20 }}>
              <div className="adm-row" style={{ justifyContent: "space-between" }}>
                <h2 id="daily-h" className="adm-h2">{labels[metric]}</h2>
                <div role="group" aria-label="Metric" className="adm-seg adm-seg-sm">
                  {metrics.map(([id, label]) => <button key={id} type="button" aria-pressed={metric === id} onClick={() => setMetric(id)}>{label}</button>)}
                </div>
              </div>
              {days.length ? (
                <>
                  <div className="adm-chart" role="img" aria-label={`${labels[metric]}, ${dayFmt(days[0]!.day)} to ${dayFmt(days[days.length - 1]!.day)}; highest ${fmtVal(val(peak))} on ${dayFmt(peak.day)}.`}>
                    {days.map((d) => <div key={d.day} data-today={d.day === today} style={{ height: `${Math.max(1, Math.round((val(d) / max) * 100))}%` }} title={`${dayFmt(d.day)}: ${fmtVal(val(d))}`} />)}
                  </div>
                  <div className="adm-chart-axis" aria-hidden="true">
                    <span>{dayFmt(days[0]!.day)}</span>
                    {days.length > 2 && <span>{dayFmt(days[Math.floor(days.length / 2)]!.day)}</span>}
                    <span>{dayFmt(days[days.length - 1]!.day)}{days[days.length - 1]!.day === today ? " (today)" : ""}</span>
                  </div>
                  <table className="adm-sr">
                    <caption>{labels[metric]}</caption>
                    <thead><tr><th scope="col">Day</th><th scope="col">Value</th></tr></thead>
                    <tbody>{days.map((d) => <tr key={d.day}><td>{d.day}</td><td>{fmtVal(val(d))}</td></tr>)}</tbody>
                  </table>
                </>
              ) : <p className="adm-empty">No daily numbers yet.</p>}
            </section>

            <section aria-labelledby="by-h" className="adm-section">
              <h2 id="by-h" className="adm-h2">By camera</h2>
              <div className="adm-table-wrap">
                <table className="adm-table" style={{ minWidth: 640 }}>
                  <thead><tr><th scope="col">Camera</th><th scope="col" style={{ textAlign: "right" }}>Minutes</th><th scope="col" style={{ textAlign: "right" }}>Storage</th><th scope="col" style={{ textAlign: "right" }}>AI checks</th></tr></thead>
                  <tbody>
                    {byCam.map(([id, min]) => (
                      <tr key={id}>
                        <td>{sources.name(id)}</td>
                        <td className="adm-num">{fmtNum(min)}</td>
                        <td className="adm-num">{u.storage_gb_by_source?.[id] !== undefined ? `${fmtNum(u.storage_gb_by_source[id]!, 1)} GB` : "—"}</td>
                        <td className="adm-num">{u.ai_checks_by_source?.[id] !== undefined ? fmtNum(u.ai_checks_by_source[id]!) : "—"}</td>
                      </tr>
                    ))}
                    {!byCam.length && <tr><td colSpan={4} className="adm-empty">No camera has recorded this period.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        );
      }}
    </LoadState>
  );
}
