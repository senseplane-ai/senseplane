// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";

/** Plays a signed HLS URL (fMP4). Native HLS on Safari, hls.js elsewhere. */
export function Player({ url, onStarted }: { url: string; onStarted?: (ms: number) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const t0 = performance.now();
    const started = () => onStarted?.(Math.round(performance.now() - t0));
    video.addEventListener("playing", started, { once: true });
    setError("");
    let hls: Hls | undefined;
    if (Hls.isSupported()) {
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_e, d) => d.fatal && setError(`Playback failed: ${d.details}`));
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
    } else {
      setError("This browser cannot play HLS.");
    }
    void video.play().catch(() => {});
    return () => {
      video.removeEventListener("playing", started);
      hls?.destroy();
    };
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="player">
      <video ref={ref} controls muted playsInline data-testid="player" />
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}
