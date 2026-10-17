// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Per-camera feed for the Live view: tries the live stream (openLive) and
// falls back to the latest snapshot, refreshed every 10 s, when live video
// isn't available. Also polls the newest detection label for the overlay.
import { type RefObject, useEffect, useState } from "react";
import type { Source } from "senseplane";
import { openLive } from "../../live/client";
import { useApp } from "../../shell/AppData";
import { labelText } from "../../shell/sources";

const SNAPSHOT_MS = 10_000;
const DETECTION_MS = 10_000;
const STATS_MS = 5_000;

export interface Feed {
  live: boolean;
  latencyMs?: number;
  snapshot: string | null;
}

/** The error code an openLive rejection carries, if any (feature_not_available, limit_reached…). */
export function liveErrorCode(e: unknown): string | undefined {
  const err = e as { code?: unknown; error?: { code?: unknown } } | null;
  const code = err?.code ?? err?.error?.code;
  return typeof code === "string" ? code : undefined;
}

export function useFeed(src: Source, video: RefObject<HTMLVideoElement | null>, opts: { audio?: boolean; onError?: (e: unknown) => void } = {}): Feed {
  const { apiUrl, apiKey, client } = useApp();
  const [live, setLive] = useState(false);
  const [latencyMs, setLatency] = useState<number | undefined>();
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const audio = !!opts.audio;
  const onError = opts.onError;

  useEffect(() => {
    const el = video.current;
    if (src.status !== "online" || !el) return;
    let gone = false;
    let handle: { close(): void; stats(): Promise<{ latencyMs?: number }> } | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    el.muted = !audio;
    openLive({ apiUrl, apiKey, sourceId: src.id, video: el, audio }).then((h) => {
      if (gone) return h.close();
      handle = h;
      setLive(true);
      const read = () => void h.stats().then((s) => !gone && setLatency(s.latencyMs)).catch(() => undefined);
      read();
      timer = setInterval(read, STATS_MS);
    }, (e) => {
      if (gone) return;
      setLive(false);
      onError?.(e);
    });
    return () => {
      gone = true;
      if (timer) clearInterval(timer);
      handle?.close();
      setLive(false);
      setLatency(undefined);
    };
  }, [src.id, src.status, audio, apiUrl, apiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (live) return;
    let alive = true;
    const load = () => void client.sources.now(src.id)
      .then((n) => alive && setSnapshot(n.snapshot_url ?? null))
      .catch(() => undefined);
    load();
    const t = setInterval(load, SNAPSHOT_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [live, src.id, client]);

  return { live, latencyMs, snapshot };
}

/** "person 0.94" for the newest detection on this camera in the last minute, or null. */
export function useDetection(sourceId: string, on: boolean): string | null {
  const { client } = useApp();
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!on) {
      setLabel(null);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        let best: { at: number; text: string } | null = null;
        let n = 0;
        for await (const e of client.events.list({ source: sourceId, from: new Date(Date.now() - 60_000).toISOString() })) {
          if (++n > 50) break;
          if (!e.type.startsWith("detection.")) continue;
          const at = Date.parse(e.occurred_at);
          if (best && best.at >= at) continue;
          const what = labelText(e.labels[0] ?? e.type.split(".").pop() ?? "object");
          best = { at, text: e.confidence != null ? `${what} ${e.confidence.toFixed(2)}` : what };
        }
        if (alive) setLabel(best?.text ?? null);
      } catch {
        if (alive) setLabel(null);
      }
    };
    void load();
    const t = setInterval(() => void load(), DETECTION_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [sourceId, on, client]);
  return label;
}

/** "0.4 s" */
export const formatLatency = (ms?: number) => (ms == null ? undefined : `${(ms / 1000).toFixed(1)} s`);
