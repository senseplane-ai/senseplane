// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// What an app or API key may use (ADR 0048): which cameras and sensors, and
// which permissions. The same picker serves the MCP consent page and the
// Agents page. Permissions map onto grants: look, listen and read environment
// are senses (video, audio, temperature + humidity); set watches and see
// history are the grant's abilities.
import type { Grant, Source } from "senseplane";
import { Chip, MultiChips } from "./kit";

export type Permission = "look" | "listen" | "environment" | "watch" | "history";

export const PERMISSIONS: { id: Permission; label: string; hint: string; senses?: string[]; ability?: "watch" | "history" }[] = [
  { id: "look", label: "Look", hint: "see live pictures and ask about them", senses: ["video"] },
  { id: "listen", label: "Listen", hint: "hear sounds such as crying or alarms (never speech)", senses: ["audio"] },
  { id: "environment", label: "Read environment", hint: "temperature and humidity", senses: ["temperature", "humidity"] },
  { id: "watch", label: "Set watches", hint: "watch for something and report it", ability: "watch" },
  { id: "history", label: "See history and replay", hint: "events, search and recordings older than two hours", ability: "history" },
];

export interface Access {
  sources: string[];
  permissions: Permission[];
}

/** Audio is opt-in: new apps get everything except listening. */
export const defaultPermissions: Permission[] = ["look", "environment", "watch", "history"];

/** The grant body for an access choice. */
export function grantBody(a: Access): { source_ids: string[]; senses: string[]; abilities: ("watch" | "history")[] } {
  const picked = PERMISSIONS.filter((p) => a.permissions.includes(p.id));
  return {
    source_ids: a.sources,
    senses: picked.flatMap((p) => p.senses ?? []),
    abilities: picked.flatMap((p) => (p.ability ? [p.ability] : [])),
  };
}

/** An agent's current access, read back from its grants (union). */
export function accessOf(grants: Grant[]): Access {
  const senses = new Set(grants.flatMap((g) => g.senses as string[]));
  const abilities = new Set(grants.flatMap((g) => (g.abilities as string[] | undefined) ?? ["watch", "history"]));
  return {
    sources: [...new Set(grants.flatMap((g) => g.source_ids))],
    permissions: PERMISSIONS.filter((p) => (p.senses ? p.senses.some((s) => senses.has(s)) : abilities.has(p.ability!))).map((p) => p.id),
  };
}

/** Allow needs a source and something to sense with. */
export const accessComplete = (a: Access) => a.sources.length > 0 && grantBody(a).senses.length > 0;

export function AccessPicker({ sources, value, onChange, disabled, idPrefix = "access" }: {
  sources: Source[]; value: Access; onChange: (a: Access) => void; disabled?: boolean; idPrefix?: string;
}) {
  const sensors = sources.some((s) => s.type === "sensor");
  const toggle = (p: Permission) => onChange({ ...value, permissions: value.permissions.includes(p) ? value.permissions.filter((x) => x !== p) : [...value.permissions, p] });
  const missingSense = value.sources.length > 0 && !grantBody(value).senses.length;
  return (
    <div className="adm-stack" style={{ gap: 18 }}>
      <fieldset className="adm-fieldset" aria-describedby={`${idPrefix}-src-count`}>
        <legend className="adm-legend">
          Cameras and sensors <span id={`${idPrefix}-src-count`} className="adm-legend-count">{value.sources.length} of {sources.length}</span>
        </legend>
        {sources.length ? (
          <MultiChips all={sensors ? "All cameras and sensors" : "All cameras"} items={sources.map((s) => ({ id: s.id, label: s.name }))} value={value.sources}
            onChange={(v) => onChange({ ...value, sources: v })} disabled={disabled} />
        ) : (
          <p className="adm-note">There are no cameras or sensors in this workspace yet. Add one first, then come back.</p>
        )}
      </fieldset>
      <fieldset className="adm-fieldset">
        <legend className="adm-legend">Can</legend>
        <div className="adm-chips">
          {PERMISSIONS.map((p) => <Chip key={p.id} check on={value.permissions.includes(p.id)} disabled={disabled} onClick={() => toggle(p.id)}>{p.label}</Chip>)}
        </div>
        <ul className="adm-perm-hints">
          {PERMISSIONS.filter((p) => value.permissions.includes(p.id)).map((p) => <li key={p.id}><span>{p.label}:</span> {p.hint}</li>)}
        </ul>
        {missingSense && <p className="adm-warn-note adm-small" role="status">Pick at least one of Look, Listen or Read environment.</p>}
      </fieldset>
    </div>
  );
}

/** Short words for an access summary ("Look · Set watches"). */
export const permissionLabels = (a: Access) => PERMISSIONS.filter((p) => a.permissions.includes(p.id)).map((p) => p.label);
