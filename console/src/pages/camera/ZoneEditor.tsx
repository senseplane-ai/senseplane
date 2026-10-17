// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Zones and privacy masks drawn over the latest snapshot. Click (or move the
// crosshair with the arrow keys and press Enter) to add points, "Close shape"
// to finish. Masks are blacked out before any model sees a frame.
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { type Senseplane, SenseplaneError, type Source } from "senseplane";
import { Button, FrameGround, Input } from "../../ui";

type Pt = [number, number];
type Zone = { name: string; polygon: Pt[] };
const round = (n: number) => +Math.min(1, Math.max(0, n)).toFixed(4);

export function ZoneEditor({ client, source, onSaved }: { client: Senseplane; source: Source; onSaved: (s: Source) => void }) {
  const [zones, setZones] = useState<Zone[]>((source.zones as Zone[]) ?? []);
  const [masks, setMasks] = useState<Pt[][]>((source.privacy_masks as Pt[][]) ?? []);
  const [draft, setDraft] = useState<Pt[]>([]);
  const [mode, setMode] = useState<"zone" | "mask">("mask");
  const [name, setName] = useState("front_door");
  const [snapshot, setSnapshot] = useState<string>("");
  const [cursor, setCursor] = useState<Pt>([0.5, 0.5]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const viewChanged = (source as Source & { view_changed_at?: string | null }).view_changed_at;

  useEffect(() => {
    void client.sources.now(source.id).then((n) => setSnapshot(n.snapshot_url ?? "")).catch(() => setSnapshot(""));
  }, [client, source.id]);

  const add = (e: MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    const p: Pt = [round((e.clientX - r.left) / r.width), round((e.clientY - r.top) / r.height)];
    setCursor(p);
    setDraft((d) => [...d, p]);
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const moves: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      setCursor(([x, y]) => [round(x + moves[e.key]![0]), round(y + moves[e.key]![1])]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setDraft((d) => [...d, cursor]);
    } else if (e.key === "Backspace") {
      setDraft((d) => d.slice(0, -1));
    }
  };
  const close = () => {
    if (draft.length < 3) return setMsg("A shape needs at least 3 points.");
    if (mode === "zone") {
      if (!/^[a-z0-9_]{1,40}$/.test(name)) return setMsg("Zone names use lowercase letters, digits and _.");
      setZones((z) => [...z.filter((x) => x.name !== name), { name, polygon: draft }]);
    } else setMasks((m) => [...m, draft]);
    setDraft([]);
    setMsg("");
  };
  const save = async () => {
    setBusy(true);
    try {
      const updated = await client.sources.update(source.id, { zones, privacy_masks: masks });
      onSaved(updated);
      setMsg("Saved. Masks apply to new frames within a second.");
    } catch (e) {
      setMsg(e instanceof SenseplaneError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const pts = (p: Pt[]) => p.map(([x, y]) => `${x * 100},${y * 100}`).join(" ");

  return (
    <div className="cam-masks">
      <div
        ref={box} className="frame cam-mask-canvas" onClick={add} onKeyDown={key} role="application" tabIndex={0}
        aria-label={`Drawing area. Click to add a point, or move the crosshair with the arrow keys and press Enter. ${draft.length} point${draft.length === 1 ? "" : "s"} so far.`}
      >
        <FrameGround />
        {snapshot ? <img src={snapshot} alt={`Latest view from ${source.name}`} /> : <span className="cam-mask-empty">No snapshot yet: start the camera, then come back.</span>}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {masks.map((m, i) => <polygon key={`m${i}`} points={pts(m)} className="cam-mask" />)}
          {zones.map((z) => <polygon key={z.name} points={pts(z.polygon)} className="cam-zone" />)}
          {draft.length > 0 && <polyline points={pts(draft)} className="cam-draft" />}
          <circle cx={cursor[0] * 100} cy={cursor[1] * 100} r="0.9" className="cam-cursor" />
        </svg>
      </div>
      <div className="cam-mask-side">
        <h3>Privacy masks</h3>
        <p className="muted">Masked areas are blacked out before anything is analysed, saved as a snapshot or sent to an AI model. Recordings stay as they were filmed.</p>
        {viewChanged && (
          <p role="alert" className="notice notice-warn">
            The view has changed since these masks were drawn (on {new Date(viewChanged).toLocaleString()}): the camera may have moved or zoomed. Check your masks against the picture, then save.
          </p>
        )}
        <div className="segmented" role="group" aria-label="Drawing">
          <button type="button" aria-pressed={mode === "mask"} onClick={() => setMode("mask")}>Draw a mask</button>
          <button type="button" aria-pressed={mode === "zone"} onClick={() => setMode("zone")}>Draw a zone</button>
        </div>
        {mode === "zone" && <Input aria-label="Zone name" value={name} onChange={(e) => setName(e.target.value)} />}
        <div className="cam-mask-actions">
          <Button size="sm" onClick={close} disabled={draft.length === 0}>Close shape</Button>
          <Button size="sm" variant="plain" onClick={() => setDraft([])} disabled={draft.length === 0}>Clear points</Button>
          <Button size="sm" variant="primary" onClick={() => void save()} busy={busy}>Save</Button>
        </div>
        {(zones.length > 0 || masks.length > 0) && (
          <ul className="cam-shapes">
            {masks.map((m, i) => (
              <li key={`m${i}`}>Privacy mask {i + 1} <button type="button" className="link-btn" onClick={() => setMasks((all) => all.filter((x) => x !== m))}>Remove</button></li>
            ))}
            {zones.map((z) => (
              <li key={z.name}>Zone <strong>{z.name}</strong> <button type="button" className="link-btn" onClick={() => setZones((all) => all.filter((x) => x !== z))}>Remove</button></li>
            ))}
          </ul>
        )}
        {msg && <p role="status" className="field-hint">{msg}</p>}
      </div>
    </div>
  );
}
