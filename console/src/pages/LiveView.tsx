// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Live view (ADR 0046): cameras side by side (1, 2×2 or 3×3), grouped by
// location, a focus view with actions, and the viewer allowance. Locked when
// the workspace's limits turn live view off.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../shell/AppData";
import { isVideo } from "../shell/sources";
import { prefs } from "../session";
import { EmptyState, LinkButton, Select, useToast } from "../ui";
import { Allowance, Locked } from "./live/Allowance";
import { liveErrorCode } from "./live/feed";
import { Focus } from "./live/Focus";
import { Tile } from "./live/Tile";
import "./live/live.css";

type Layout = 1 | 2 | 3;
const LAYOUTS: { n: Layout; short: string; label: string }[] = [
  { n: 1, short: "1", label: "One camera" },
  { n: 2, short: "2×2", label: "Four cameras" },
  { n: 3, short: "3×3", label: "Up to nine cameras" },
];

export function LiveViewPage() {
  const { sources, limits } = useApp();
  const toast = useToast();
  const [layout, setLayoutState] = useState<Layout>(() => {
    const v = prefs.get<number>("liveLayout", 3);
    return v === 1 || v === 2 ? v : 3;
  });
  const [group, setGroup] = useState("");
  const [detections, setDetections] = useState(() => prefs.get<boolean>("liveDetections", true));
  const [focus, setFocus] = useState<string | null>(null);
  const [serverLocked, setServerLocked] = useState(false);
  const warned = useRef(0);

  useEffect(() => {
    document.title = "Live view · Senseplane";
  }, []);

  const setLayout = (n: Layout) => {
    setLayoutState(n);
    setFocus(null);
    prefs.set("liveLayout", n);
  };
  const toggleDetections = () => {
    setDetections(!detections);
    prefs.set("liveDetections", !detections);
  };

  const cams = useMemo(() => (sources ?? []).filter(isVideo), [sources]);
  const groups = useMemo(() => [...new Set(cams.map((c) => c.location).filter((l): l is string => !!l))].sort(), [cams]);
  const inGroup = group ? cams.filter((c) => c.location === group) : cams;
  const tiles = inGroup.slice(0, layout === 1 ? 1 : layout === 2 ? 4 : 9);
  const focused = focus ? cams.find((c) => c.id === focus) ?? null : null;
  const locked = limits.live_view === false || serverLocked;
  const onlineCount = inGroup.filter((c) => c.status === "online").length;

  const onLiveError = useCallback((e: unknown) => {
    const code = liveErrorCode(e);
    if (code === "feature_not_available") setServerLocked(true);
    if (code === "limit_reached" && Date.now() - warned.current > 30_000) {
      warned.current = Date.now();
      toast("Too many people are watching right now. Try again in a minute.", "error");
    }
  }, [toast]);

  useEffect(() => {
    if (!focused) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.fullscreenElement) setFocus(null);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [focused]);

  const heading = locked ? "Live view" : focused ? focused.name : `${onlineCount} of ${inGroup.length} cameras live`;

  return (
    <div className="page lv-page">
      <header className="lv-header">
        <div className="lv-title">
          <span className="lv-eyebrow"><span className="dot dot-live dot-halo" style={{ width: 7, height: 7 }} aria-hidden="true" />LIVE VIEW</span>
          <h1 className="lv-h1">{heading}</h1>
        </div>
        {!locked && cams.length > 0 && (
          <div className="lv-controls">
            <Select aria-label="Camera group" value={group} onChange={(e) => { setGroup(e.target.value); setFocus(null); }} className="lv-group">
              <option value="">All cameras</option>
              {groups.map((g) => <option key={g} value={g}>{g}</option>)}
            </Select>
            <button type="button" className="btn btn-secondary btn-sm lv-detect" aria-pressed={detections} onClick={toggleDetections}>Show detections</button>
            <div role="group" aria-label="Layout" className="segmented">
              {LAYOUTS.map((l) => (
                <button key={l.n} type="button" aria-label={l.label} aria-pressed={layout === l.n} onClick={() => setLayout(l.n)}>{l.short}</button>
              ))}
            </div>
          </div>
        )}
      </header>

      {locked ? (
        <Locked />
      ) : sources && cams.length === 0 ? (
        <EmptyState icon="live" title="No cameras yet" actions={<LinkButton to="/cameras/new" variant="primary" icon="plus">Add camera</LinkButton>}>
          Add a camera and watch it here as it happens.
        </EmptyState>
      ) : focused ? (
        <Focus
          key={focused.id} source={focused} others={inGroup.filter((c) => c.id !== focused.id)} detections={detections}
          onBack={() => setFocus(null)} onPick={setFocus} onLiveError={onLiveError}
        />
      ) : (
        <div className="lv-grid" style={{ "--cols": layout } as React.CSSProperties}>
          {tiles.map((s, i) => (
            <Tile key={`${layout}-${s.id}`} source={s} index={i} detections={detections} onFocus={() => setFocus(s.id)} onLiveError={onLiveError} />
          ))}
        </div>
      )}

      {!locked && cams.length > 0 && <Allowance />}
    </div>
  );
}
