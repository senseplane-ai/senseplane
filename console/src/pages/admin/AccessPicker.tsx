// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// What an app or API key may use (ADR 0048): which cameras and sensors, and
// which permissions. The same picker serves the MCP consent page and the
// Agents page. Permissions map onto grants: look, listen and read environment
// are senses (video, audio, and "sensors" for every sensor sense); control devices is
// the sense "control", never implied by "sensors" and off by default; set watches and
// see history are the grant's abilities; only blurred pictures is the grant's
// blurred_only (ADR 0068).
import { type Grant, type Source, isSensorSense } from "senseplane";
import { Chip, MultiChips } from "./kit";

export type Permission = "look" | "listen" | "environment" | "control" | "watch" | "history" | "blurred";

export const PERMISSIONS: { id: Permission; label: string; hint: string; senses?: string[]; ability?: "watch" | "history" }[] = [
  { id: "look", label: "Look", hint: "see live pictures and ask about them", senses: ["video"] },
  { id: "listen", label: "Listen", hint: "hear sounds such as crying or alarms (never speech)", senses: ["audio"] },
  // "sensors" covers every sensor sense: temperature, doors, plugs, leaks and any added later (ADR 0060).
  { id: "environment", label: "Read sensors", hint: "temperature, doors and windows, plugs, leaks and other sensors", senses: ["sensors"] },
  // Switching things is its own sense: off by default and never implied by "Read sensors".
  {
    id: "control", label: "Control devices", senses: ["control"],
    hint: "switch the devices an admin marked controllable; locks, garage doors, gates and alarms still need a person to confirm",
  },
  { id: "watch", label: "Set watches", hint: "watch for something and report it", ability: "watch" },
  { id: "history", label: "See history and replay", hint: "events, search and recordings older than two hours", ability: "history" },
  // Not a sense: a limit on the others (ADR 0068).
  {
    id: "blurred", label: "Only blurred pictures",
    hint: "faces and number plates blurred in every picture and answer; no recordings, clips or live view",
  },
];

export interface Access {
  sources: string[];
  permissions: Permission[];
}

/** Audio is opt-in: new apps get everything except listening. */
export const defaultPermissions: Permission[] = ["look", "environment", "watch", "history"];

/** The grant body for an access choice. */
export function grantBody(a: Access): { source_ids: string[]; senses: string[]; abilities: ("watch" | "history")[]; blurred_only?: true } {
  const picked = PERMISSIONS.filter((p) => a.permissions.includes(p.id));
  return {
    source_ids: a.sources,
    senses: picked.flatMap((p) => p.senses ?? []),
    abilities: picked.flatMap((p) => (p.ability ? [p.ability] : [])),
    ...(a.permissions.includes("blurred") ? { blurred_only: true as const } : {}),
  };
}

/** An agent's current access, read back from its grants (union). */
export function accessOf(grants: Grant[]): Access {
  const senses = new Set(grants.flatMap((g) => g.senses as string[]));
  // "control" is a sense, but switching things never reads as "Read sensors".
  const reads = [...senses].filter((s) => s !== "control" && isSensorSense(s));
  const abilities = new Set(grants.flatMap((g) => (g.abilities as string[] | undefined) ?? ["watch", "history"]));
  return {
    sources: [...new Set(grants.flatMap((g) => g.source_ids))],
    // Older grants name sensor senses one by one (temperature, humidity): they read as "Read sensors" too.
    permissions: PERMISSIONS.filter((p) =>
      p.id === "environment" ? reads.length > 0
      : p.id === "blurred" ? grants.some((g) => (g as { blurred_only?: boolean }).blurred_only)
      : p.senses ? p.senses.some((s) => senses.has(s)) : abilities.has(p.ability!)).map((p) => p.id),
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
        {missingSense && <p className="adm-warn-note adm-small" role="status">Pick at least one of Look, Listen, Read sensors or Control devices.</p>}
      </fieldset>
    </div>
  );
}

/** Short words for an access summary ("Look · Set watches"). */
export const permissionLabels = (a: Access) => PERMISSIONS.filter((p) => a.permissions.includes(p.id)).map((p) => p.label);
