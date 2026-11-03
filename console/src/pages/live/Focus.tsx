// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import type { Source } from "senseplane";
import { errorText } from "../../api/extra";
import { Link } from "../../router";
import { useApp } from "../../shell/AppData";
import { statusOf } from "../../shell/sources";
import { Button, FrameGround, IconButton, StatusDot, useToast } from "../../ui";
import type { Talk } from "../../live/client";
import { formatLatency, useDetection, useFeed } from "./feed";
import { lastSeen } from "./Tile";

/**
 * Push-to-talk (ADR 0069, 0074): a camera whose `talk` is true (a phone, or an IP camera whose box can carry
 * live audio), for people who are members and up. An API before `talk` offered it on phones with a speaker.
 */
export const canTalk = (source: Source, role: string | undefined) =>
  (source.talk ?? (source.type === "browser" && !!source.speaker)) && (!role || ["owner", "admin", "member"].includes(role));

/** Why a camera with a speaker has no Hold to talk, for the people who could otherwise talk. */
export const noTalkReason = (source: Source) =>
  source.speaker && source.type === "rtsp" && !canTalk(source, undefined)
    ? "Its box plays agents' messages here, but can't carry push-to-talk: the box needs updating, or the camera's speaker isn't G.711."
    : undefined;

/** Hold to talk: the microphone goes to the camera's speaker while the button is held. */
export function TalkButton({ talk, name }: { talk: Talk; name: string }) {
  const toast = useToast();
  const [on, setOn] = useState(false);
  const [heard, setHeard] = useState(false);
  useEffect(() => talk.onState?.((s) => {
    if (s.state === "listening") setHeard(true);
    else if (s.state === "connecting") setHeard(false);
    else {
      setOn(false);
      setHeard(false);
      toast(s.message, "error");
    }
  }), [talk, toast]);
  const start = () => {
    if (on) return;
    setOn(true);
    setHeard(!talk.onState); // no word from the camera's side: as before, talking at once
    void talk.start().catch((e) => {
      setOn(false);
      toast(e instanceof Error ? e.message : "Couldn't use the microphone.", "error");
    });
  };
  const stop = () => {
    if (!on) return;
    setOn(false);
    setHeard(false);
    void talk.stop();
  };
  const label = !on ? "Hold to talk" : heard ? "Talking… release to stop" : "Connecting to the speaker…";
  return (
    <button type="button" className={`btn btn-sm lv-talk${on ? " lv-talk-on" : ""}`} aria-pressed={on}
      aria-label={on ? (heard ? `Talking through ${name}; release to stop` : `Connecting to ${name}'s speaker; release to stop`) : `Hold to talk through ${name}`}
      onPointerDown={(e) => { e.preventDefault(); start(); }} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onKeyDown={(e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); start(); } }}
      onKeyUp={(e) => { if (e.key === " " || e.key === "Enter") stop(); }}
      onBlur={stop}>
      {label}
    </button>
  );
}

/** One camera large, with actions and a strip of the others. */
export function Focus({ source, others, detections, onBack, onPick, onLiveError }: {
  source: Source; others: Source[]; detections: boolean; onBack: () => void; onPick: (id: string) => void; onLiveError: (e: unknown) => void;
}) {
  const { client, me } = useApp();
  const toast = useToast();
  const frame = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [audio, setAudio] = useState(false);
  const [saving, setSaving] = useState(false);
  const talkable = canTalk(source, me?.role);
  const feed = useFeed(source, video, { audio, talk: talkable, onError: onLiveError });
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
            {source.speaker && <span className="lv-focus-label">Has a speaker</span>}
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
          {feed.talk && <TalkButton talk={feed.talk} name={source.name} />}
        </div>
        {feed.talk && (
          <p className="muted lv-talk-note">
            {source.type === "browser"
              ? <>Whoever is near {source.name} hears you. The phone shows that someone is speaking, and it&apos;s in the audit log.</>
              : <>Whoever is near {source.name} hears you through its speaker, a moment after you speak. It&apos;s in the audit log.</>}
          </p>
        )}
        {!feed.talk && canTalk({ ...source, talk: true }, me?.role) && noTalkReason(source) && <p className="muted lv-talk-note">{noTalkReason(source)}</p>}
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
