// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Recorded playback: a signed HLS range played with hls.js (native HLS on
// Safari), its controls, and today's timeline. The loaded range starts at the
// chosen position and runs up to an hour; scrubbing loads a new range.
import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Event, Source } from "senseplane";
import { errorText } from "../../api/extra";
import { useApp } from "../../shell/AppData";
import { startOfToday } from "../../shell/sources";
import { Frame, Icon, useToast } from "../../ui";
import { type Marker, TodayTimeline } from "./Timeline";
import { dayLabel, snapToRecorded } from "./time";

const HOUR = 3600_000;
const LATEST = 2 * 60_000;
const SPEEDS = [1, 2, 4, 0.5];
type Range = { from: number; to: number };

export function Playback({ source, events, initialAt }: { source: Source; events: Event[]; initialAt?: number }) {
  const { client } = useApp();
  const toast = useToast();
  const video = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [recorded, setRecorded] = useState<Range[] | null>(null);
  const [start, setStart] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState("");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0);
  const [saving, setSaving] = useState(false);
  const dayStart = startOfToday(new Date(now));
  const position = (start ?? now - LATEST) + offset;

  const loadTimeline = useCallback(async () => {
    const t = Date.now();
    setNow(t);
    try {
      const tl = await client.sources.timeline(source.id, { from: new Date(startOfToday(new Date(t))).toISOString(), to: new Date(t).toISOString() });
      setRecorded(tl.recorded.map((r) => ({ from: Date.parse(r.from), to: Date.parse(r.to) })));
    } catch {
      setRecorded((r) => r ?? []);
    }
  }, [client, source.id]);

  useEffect(() => {
    void loadTimeline();
    const timer = setInterval(() => void loadTimeline(), 30_000);
    return () => clearInterval(timer);
  }, [loadTimeline]);

  const load = useCallback(async (t: number) => {
    const end = Date.now();
    let from = Math.min(t, end - 5_000);
    const to = Math.min(from + HOUR, end);
    if (to - from < 5_000) from = to - LATEST;
    setStart(from);
    setOffset(0);
    setMessage("");
    try {
      const r = await client.sources.playback(source.id, { from: new Date(from).toISOString(), to: new Date(to).toISOString() });
      setUrl(r.url);
    } catch (e) {
      setUrl("");
      const status = (e as { status?: number }).status;
      setMessage(status === 404 ? "Nothing was recorded at this time. Pick a shaded part of the timeline." : errorText(e));
    }
  }, [client, source.id]);

  // First position: the deep-linked time, else the latest recording.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || recorded === null) return;
    started.current = true;
    const last = recorded[recorded.length - 1];
    void load(initialAt ?? (last ? Math.max(last.from, last.to - LATEST) : Date.now() - LATEST));
  }, [recorded, initialAt, load]);
  // A new ?t= while the page is open (a search result or moment for this camera) moves there.
  const shownAt = useRef(initialAt);
  useEffect(() => {
    if (!started.current || initialAt === undefined || initialAt === shownAt.current) return;
    shownAt.current = initialAt;
    void load(initialAt);
  }, [initialAt, load]);

  // Attach the HLS source.
  useEffect(() => {
    const v = video.current;
    if (!v || !url) return;
    let hls: Hls | undefined;
    if (Hls.isSupported()) {
      hls = new Hls();
      hls.on(Hls.Events.ERROR, (_e, d) => d.fatal && setMessage(`Playback failed: ${d.details}`));
      hls.loadSource(url);
      hls.attachMedia(v);
    } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
      v.src = url;
    } else {
      setMessage("This browser cannot play recordings.");
      return;
    }
    v.playbackRate = SPEEDS[speed]!;
    void v.play().catch(() => setPlaying(false));
    return () => hls?.destroy();
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlay = () => {
    const v = video.current;
    if (!v || !url) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };
  const nudge = (seconds: number) => {
    const v = video.current;
    if (v && url && v.currentTime + seconds >= 0 && (Number.isNaN(v.duration) || v.currentTime + seconds < v.duration)) {
      v.currentTime += seconds;
    } else {
      void load(position + seconds * 1000);
    }
  };
  const cycleSpeed = () => {
    const next = (speed + 1) % SPEEDS.length;
    setSpeed(next);
    if (video.current) video.current.playbackRate = SPEEDS[next]!;
  };
  const latest = () => {
    const last = recorded?.[recorded.length - 1];
    void load(last ? Math.max(last.from, last.to - LATEST) : Date.now() - LATEST);
  };
  const seek = (t: number) => void load(recorded?.length ? snapToRecorded(t, recorded) : t);

  const saveClip = async () => {
    const range = recorded?.find((r) => position >= r.from && position <= r.to);
    let from = position - 15_000;
    let to = position + 15_000;
    if (range) {
      from = Math.max(from, range.from);
      to = Math.min(to, range.to);
    }
    to = Math.min(to, Date.now());
    if (to - from < 1_000) from = to - 30_000;
    setSaving(true);
    try {
      await client.clips.create({ source: source.id, from: new Date(from).toISOString(), to: new Date(to).toISOString() });
      toast("Clip saved. It is kept until you delete it.");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const markers: Marker[] = events.map((e) => ({ id: e.id, at: Date.parse(e.occurred_at), watch: e.type === "watch.triggered" }))
    .filter((m) => m.at >= dayStart);

  return (
    <section aria-label="Recording playback" className="cam-playback">
      <Frame alt="" className="cam-video">
        <video
          ref={video} playsInline muted={!source.record_audio} className="contain" data-testid="player"
          onTimeUpdate={(e) => setOffset(Math.round(e.currentTarget.currentTime * 1000))}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
          style={{ visibility: url ? "visible" : "hidden" }}
        />
        <span className="frame-label tl cam-rec-label">RECORDED · {dayLabel(position, now)}</span>
        {message ? (
          <p className="cam-video-msg" role="status">{message}</p>
        ) : (
          <button type="button" className="cam-play" aria-label={playing ? "Pause" : "Play"} onClick={togglePlay} disabled={!url}>
            <Icon name={playing ? "pause" : "play"} size={22} />
          </button>
        )}
      </Frame>

      <div className="cam-controls">
        <div className="cam-control-group">
          <button type="button" className="cam-ctl mono" aria-label="Back 10 seconds" onClick={() => nudge(-10)}>−10s</button>
          <button type="button" className="cam-ctl mono" aria-label="Forward 10 seconds" onClick={() => nudge(10)}>+10s</button>
          <button type="button" className="cam-ctl mono" aria-label={`Playback speed ${SPEEDS[speed]}×`} onClick={cycleSpeed}>{SPEEDS[speed]}×</button>
        </div>
        <div className="cam-control-group">
          <button type="button" className="cam-ctl" onClick={latest}>Jump to latest recording</button>
          <button type="button" className="cam-ctl" onClick={() => void saveClip()} disabled={saving}>Save clip</button>
        </div>
      </div>

      <TodayTimeline dayStart={dayStart} now={now} recorded={recorded ?? []} markers={markers} position={position} onSeek={seek} />
    </section>
  );
}

