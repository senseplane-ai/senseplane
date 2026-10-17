// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";
import type { Source } from "senseplane";
import { errorText } from "../../api/extra";
import { Link } from "../../router";
import { useApp } from "../../shell/AppData";
import { statusOf } from "../../shell/sources";
import { Button, FrameGround, IconButton, StatusDot, useToast } from "../../ui";
import { formatLatency, useDetection, useFeed } from "./feed";
import { lastSeen } from "./Tile";

/** One camera large, with actions and a strip of the others. */
export function Focus({ source, others, detections, onBack, onPick, onLiveError }: {
  source: Source; others: Source[]; detections: boolean; onBack: () => void; onPick: (id: string) => void; onLiveError: (e: unknown) => void;
}) {
  const { client } = useApp();
  const toast = useToast();
  const frame = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [audio, setAudio] = useState(false);
  const [saving, setSaving] = useState(false);
  const feed = useFeed(source, video, { audio, onError: onLiveError });
  const detection = useDetection(source.id, detections && source.status === "online");
  const status = statusOf(source);
  const down = status.kind !== "on";
  const hasAudio = source.senses.includes("audio");
  const latency = formatLatency(feed.latencyMs);

  const saveLast = async () => {
    const to = new Date();
    setSaving(true);
    try {
      await client.clips.create({ source: source.id, from: new Date(to.getTime() - 30_000).toISOString(), to: to.toISOString(), title: `${source.name} live` });
      toast("Saved the last 30 seconds");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSaving(false);
    }
  };
  const fullscreen = () => {
    const el = frame.current;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el?.requestFullscreen?.().catch(() => undefined);
  };

  return (
    <div className="lv-focus">
      <div className="lv-focus-main">
        <div ref={frame} className="lv-focus-frame">
          <FrameGround />
          {!feed.live && feed.snapshot && <img className="lv-media" src={feed.snapshot} alt={`Latest frame from ${source.name}`} />}
          <video ref={video} className="lv-media lv-media-contain" data-live={feed.live || undefined} muted={!audio} playsInline autoPlay aria-label={`${source.name} live video`} />
          {detection && !down && <span className="lv-detection lv-detection-lg">{detection}</span>}
          <span className="lv-focus-labels">
            {feed.live && <span className="live-badge">LIVE</span>}
            <span className="lv-focus-label">{source.name} · {feed.live ? (latency ? `${latency} behind` : "live") : down ? status.label.toLowerCase() : "snapshot"}</span>
          </span>
          {down && (
            <span className="lv-down">
              <span className={status.kind === "attention" ? "lv-down-warn" : "lv-down-off"}>{status.label}</span>
              {lastSeen(source) && <span className="lv-down-since">{lastSeen(source)}</span>}
            </span>
          )}
          <span className="lv-focus-tools">
            {hasAudio && (
              <IconButton icon={audio ? "sound" : "muted"} label={audio ? "Mute" : "Unmute"} variant="overlay" size={36} aria-pressed={audio} onClick={() => setAudio(!audio)} />
            )}
            <IconButton icon="fullscreen" label="Full screen" variant="overlay" size={36} onClick={fullscreen} />
          </span>
        </div>
        <div className="lv-actions">
          <Button size="sm" onClick={onBack}>← All cameras</Button>
          <Link className="btn btn-ghost btn-sm" to={`/cameras/${source.id}?t=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`}>Rewind 1 minute</Link>
          <Button size="sm" onClick={() => void saveLast()} busy={saving}>Save the last 30 s</Button>
          <Link className="btn btn-ghost btn-sm" to={`/?camera=${source.id}`}>Ask about this camera</Link>
        </div>
      </div>
      {others.length > 0 && (
        <div className="lv-others">
          <span className="lv-others-title" id="lv-others">Other cameras</span>
          <ul aria-labelledby="lv-others">
            {others.map((o, i) => (
              <li key={o.id}>
                <button type="button" className="lv-other" onClick={() => onPick(o.id)} aria-label={`Open ${o.name} large`}>
                  <FrameGround variant={i + 1} />
                  <span className="lv-other-bar"><StatusDot tone={statusOf(o).tone} size={6} />{o.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
