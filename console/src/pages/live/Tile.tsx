// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { useRef } from "react";
import type { Source } from "senseplane";
import { ingestLabel, noVideoSince, statusOf } from "../../shell/sources";
import { FrameGround } from "../../ui";
import { formatLatency, useDetection, useFeed } from "./feed";

/** When the camera last sent video, if the server reports it. */
export const lastSeen = (s: Source): string | undefined => noVideoSince(s);

/** One camera in the grid: live video when it opens, otherwise the latest snapshot. */
export function Tile({ source, index, detections, onFocus, onLiveError }: {
  source: Source; index: number; detections: boolean; onFocus: () => void; onLiveError: (e: unknown) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const feed = useFeed(source, video, { onError: onLiveError });
  const detection = useDetection(source.id, detections && source.status === "online");
  const status = statusOf(source);
  const down = status.kind !== "on";
  const res = source.max_resolution;
  const meta = feed.live
    ? [res, formatLatency(feed.latencyMs)].filter(Boolean).join(" · ") || "LIVE"
    : down ? ingestLabel(source).toLowerCase() : "SNAPSHOT";
  return (
    <button
      type="button" className={["lv-tile", down && status.kind === "attention" && "lv-tile-warn"].filter(Boolean).join(" ")}
      aria-label={`Open ${source.name} large`} onClick={onFocus}
    >
      <FrameGround variant={index} />
      {!feed.live && feed.snapshot && <img className="lv-media" src={feed.snapshot} alt="" />}
      <video ref={video} className="lv-media" data-live={feed.live || undefined} muted playsInline autoPlay aria-hidden="true" />
      {detection && !down && <span className="lv-detection">{detection}</span>}
      {feed.live && <span className="live-badge lv-badge">LIVE</span>}
      {down && (
        <span className="lv-down">
          <span className={status.kind === "attention" ? "lv-down-warn" : "lv-down-off"}>{status.label}</span>
          {lastSeen(source) && <span className="lv-down-since">{lastSeen(source)}</span>}
        </span>
      )}
      <span className="lv-bar">
        <span className="lv-name">{source.name}</span>
        <span className="lv-meta">{meta}</span>
      </span>
    </button>
  );
}
