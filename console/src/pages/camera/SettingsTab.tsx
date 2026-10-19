// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Per-camera settings: name, site, retention override, record audio, resolution (read-only).
import { useState } from "react";
import type { Source } from "senseplane";
import { errorText } from "../../api/extra";
import { useApp } from "../../shell/AppData";
import { isVideo } from "../../shell/sources";
import { Toggle, useToast } from "../../ui";

type Retention = "default" | "1" | "7" | "30" | "90" | "fill";

export function retentionValue(s: Source): Retention {
  const mode = (s as Source & { retention_mode?: string | null }).retention_mode;
  if (mode === "fill") return "fill";
  if (s.retention_days == null) return "default";
  return (["1", "7", "30", "90"] as const).find((d) => Number(d) === s.retention_days) ?? "default";
}

export function retentionBody(v: Retention) {
  if (v === "default") return { retention_days: null, retention_mode: null };
  if (v === "fill") return { retention_mode: "fill" as const, retention_days: null };
  return { retention_days: Number(v), retention_mode: "days" as const };
}

export function SettingsTab({ source }: { source: Source }) {
  const { client, putSource, account } = useApp();
  const toast = useToast();
  const [name, setName] = useState(source.name);
  const [site, setSite] = useState(source.site ?? "");
  const [busy, setBusy] = useState(false);

  const save = async (body: Parameters<typeof client.sources.update>[1], done = "Saved.") => {
    setBusy(true);
    try {
      const updated = await client.sources.update(source.id, body);
      putSource(updated);
      toast(done);
      return true;
    } catch (e) {
      toast(errorText(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const saveName = () => {
    const n = name.trim();
    if (!n || n === source.name) return setName(source.name);
    void save({ name: n }, "Name saved.");
  };
  const saveSite = () => {
    const v = site.trim();
    setSite(v);
    if (v === (source.site ?? "")) return;
    void save({ site: v || null }, v ? "Site saved." : "Site cleared.");
  };

  const accDefault = account?.retention_mode === "fill" ? "until storage is full"
    : account?.retention_days == null ? "until deleted" : `${account.retention_days} days`;
  const custom = source.retention_days != null && !["1", "7", "30", "90"].includes(String(source.retention_days));
  const res = (source as Source & { max_resolution?: string }).max_resolution;

  return (
    <div className="cam-settings">
      <div className="card-row field">
        <label htmlFor="cam-name" className="toggle-label">Name</label>
        <input
          id="cam-name" className="input input-md" value={name} maxLength={120}
          onChange={(e) => setName(e.target.value)} onBlur={saveName}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveName(); } }}
        />
      </div>
      <div className="card-row field">
        <label htmlFor="cam-site" className="toggle-label">Site</label>
        <input
          id="cam-site" className="input input-md" value={site} maxLength={120} placeholder="Home, High St shop"
          onChange={(e) => setSite(e.target.value)} onBlur={saveSite}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveSite(); } }}
        />
        <span className="field-hint">Groups cameras by place, so you can ask about one place at a time.</span>
      </div>
      <div className="card-row field">
        <label htmlFor="cam-keep" className="toggle-label">Keep recordings for</label>
        <select
          id="cam-keep" className="input select input-md" disabled={busy}
          value={custom ? "custom" : retentionValue(source)}
          onChange={(e) => void save(retentionBody(e.target.value as Retention), "Retention saved.")}
        >
          <option value="default">Account default ({accDefault})</option>
          {custom && <option value="custom" disabled>{source.retention_days} days</option>}
          <option value="1">1 day</option>
          <option value="7">7 days</option>
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="fill">Until storage is full</option>
        </select>
      </div>
      {isVideo(source) && (
        <Toggle
          label="Record audio" hint="Sounds are still analysed when this is off." checked={source.record_audio} disabled={busy}
          onChange={(v) => void save({ record_audio: v }, v ? "Audio will be recorded." : "Audio won't be recorded.")}
        />
      )}
      {isVideo(source) && (
        <div className="card-row toggle-row">
          <span className="toggle-text">
            <span className="toggle-label">Resolution</span>
            <span className="field-hint">Set for this workspace. Streams above it are refused, not resized.</span>
          </span>
          <span className="mono cam-res">{res ?? "—"}</span>
        </div>
      )}
    </div>
  );
}
