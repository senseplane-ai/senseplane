// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// "Today" timeline: recorded ranges, event and watch-fired markers, and a
// playhead you can drag, click or move with the keyboard (role="slider").
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import { DAY_MS, clock, pct } from "./time";

export interface Marker { at: number; watch: boolean; id: string }

export function TodayTimeline({ dayStart, now, recorded, markers, position, onSeek }: {
  dayStart: number; now: number; recorded: { from: number; to: number }[]; markers: Marker[];
  position: number; onSeek: (t: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? position;
  const clamp = (t: number) => Math.min(Math.max(t, dayStart), Math.min(now, dayStart + DAY_MS));
  const at = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return clamp(dayStart + ((clientX - box.left) / Math.max(box.width, 1)) * DAY_MS);
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag(at(e.clientX));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (drag !== null) setDrag(at(e.clientX));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const t = at(e.clientX);
    setDrag(null);
    onSeek(t);
  };
  const key = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 * 60_000 : 60_000;
    let t: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") t = position + step;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") t = position - step;
    if (e.key === "Home") t = recorded[0]?.from ?? dayStart;
    if (e.key === "End") t = now - 2 * 60_000;
    if (t === null) return;
    e.preventDefault();
    onSeek(clamp(t));
  };

  return (
    <div className="cam-timeline card">
      <div className="cam-tl-legend">
        <span>Today</span>
        <span className="cam-tl-keys">
          <span><span className="cam-key-rec" aria-hidden="true" />Recorded</span>
          <span><span className="cam-key-mark" aria-hidden="true" />Event</span>
          <span><span className="cam-key-mark cam-key-watch" aria-hidden="true" />Watch fired</span>
        </span>
      </div>
      <div
        ref={track} className="cam-tl-track" role="slider" tabIndex={0}
        aria-label="Recording timeline for today" aria-valuemin={dayStart} aria-valuemax={dayStart + DAY_MS}
        aria-valuenow={Math.round(shown)} aria-valuetext={clock(shown)}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)} onKeyDown={key}
      >
        <div className="cam-tl-bed" />
        {recorded.map((r) => (
          <div key={r.from} className="cam-tl-rec" style={{ left: pct(r.from, dayStart), width: `calc(${pct(r.to, dayStart)} - ${pct(r.from, dayStart)})` }} />
        ))}
        {markers.map((m) => (
          <div key={m.id} className={m.watch ? "cam-tl-mark cam-tl-watch" : "cam-tl-mark"} style={{ left: pct(m.at, dayStart) }} />
        ))}
        <div className="cam-tl-head" style={{ left: pct(shown, dayStart) }}>
          <span data-testid="playhead-label">{clock(shown)}</span>
        </div>
      </div>
      <div className="cam-tl-axis" aria-hidden="true"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
    </div>
  );
}
