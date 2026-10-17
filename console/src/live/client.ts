// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Live view in the browser (ADR 0042): asks the API for a viewer token
// (POST /v1/sources/{id}/live), then speaks media signalling v1 as a viewer:
// join → recv transport → consume each producer → resume. Nothing is
// transcoded; the <video> gets the camera's own H.264 (and Opus only when the
// key may hear it and `audio` was asked for).
//
// Viewers are closed by the API after the idle timeout unless someone is
// there: the helper tells the API (POST /v1/live/{session}/keepalive) on user
// activity (pointer, keys, touch, scroll, the tab becoming visible), at most
// every 30 s, never on a timer alone (ADR 0049).
import { Device } from "mediasoup-client";
import type { Consumer, RtpCapabilities, RtpParameters, Transport, TransportOptions } from "mediasoup-client/types";
import { PROTOCOL_VERSION, SignallingClient, SignallingError } from "../capture/signalling";

export interface OpenLiveOptions {
  /** API base, with or without the trailing /v1 (e.g. https://api.example.com/v1). */
  apiUrl: string;
  apiKey: string;
  sourceId: string;
  video: HTMLVideoElement;
  /** Also play the camera's audio (needs an audio grant; default false). */
  audio?: boolean;
}

export interface LiveView {
  close(): void;
  /** Rough glass-to-glass latency estimate: jitter buffer plus half the round trip. */
  stats(): Promise<{ latencyMs?: number }>;
}

/** Thrown with the API's or the media plane's error code (feature_not_available, limit_reached, conflict, idle…). */
export class LiveError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
  }
}

interface LiveSession {
  session_id: string;
  media_url: string;
  token: string;
  expires_at: string;
  idle_timeout_seconds: number;
  audio?: boolean;
}
type Producer = { producerId: string; kind: "audio" | "video" };

const ACTIVITY = ["pointerdown", "pointermove", "keydown", "touchstart", "wheel"] as const;

export async function openLive(opts: OpenLiveOptions): Promise<LiveView> {
  const base = opts.apiUrl.replace(/\/$/, "");
  const url = `${/\/v1$/.test(base) ? base : `${base}/v1`}/sources/${encodeURIComponent(opts.sourceId)}/live`;
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ audio: opts.audio === true }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new LiveError(json?.error?.code ?? "unknown", json?.error?.message ?? `could not start live view (${res.status})`, res.status);
  const session = json as LiveSession;

  const sig = new SignallingClient(session.media_url);
  const stream = new MediaStream();
  const consumers = new Map<string, Consumer>(); // by producer id
  let transport: Transport | undefined;
  let closed = false;
  const cleanups: (() => void)[] = [];

  /** `leave` tells the node; skipped when the node already ended the session. */
  const close = (leave = true) => {
    if (closed) return;
    closed = true;
    for (const c of cleanups.splice(0)) c();
    for (const c of consumers.values()) c.close();
    consumers.clear();
    transport?.close();
    for (const t of stream.getTracks()) stream.removeTrack(t);
    if (opts.video.srcObject === stream) opts.video.srcObject = null;
    if (leave) sig.request("leave").catch(() => undefined).finally(() => sig.close());
    else sig.close();
  };

  try {
    const joinedEvent = sig.nextEvent("joined");
    await sig.request("join", { protocolVersion: PROTOCOL_VERSION, token: session.token });
    const joined = (await joinedEvent) as unknown as { routerRtpCapabilities: RtpCapabilities; producers: Producer[] };
    const device = new Device();
    await device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });
    const params = await sig.request<TransportOptions & { transportId?: string }>("createTransport", { direction: "recv" });
    const recv = device.createRecvTransport({ ...params, id: params.transportId ?? params.id });
    transport = recv;
    recv.on("connect", ({ dtlsParameters }, ok, fail) => {
      sig.request("connectTransport", { transportId: recv.id, dtlsParameters }).then(() => ok(), fail);
    });

    const consume = async (p: Producer) => {
      if (closed || consumers.has(p.producerId)) return;
      const c = await sig.request<{ consumerId: string; producerId: string; kind: "audio" | "video"; rtpParameters: RtpParameters }>("consume", {
        transportId: recv.id, producerId: p.producerId, rtpCapabilities: device.recvRtpCapabilities,
      });
      const consumer = await recv.consume({ id: c.consumerId, producerId: c.producerId, kind: c.kind, rtpParameters: c.rtpParameters });
      consumers.set(p.producerId, consumer);
      // One track per kind: a reconnected camera replaces the old track.
      for (const t of stream.getTracks()) if (t.kind === consumer.kind) stream.removeTrack(t);
      stream.addTrack(consumer.track);
      await sig.request("resumeConsumer", { consumerId: c.consumerId });
    };

    cleanups.push(sig.onEvent((e) => {
      if (e.event === "producerAppeared" || e.event === "newProducer") void consume(e as unknown as Producer).catch(() => undefined);
      else if (e.event === "producerClosed") {
        const c = consumers.get(String(e.producerId));
        if (c) {
          consumers.delete(String(e.producerId));
          stream.removeTrack(c.track);
          c.close();
        }
      } else if (e.event === "roomClosed" || e.event === "draining") {
        // Idle, camera offline, allowance used up, node going away: the page decides whether to reopen.
        opts.video.dispatchEvent(new CustomEvent("senseplane:liveclosed", { detail: { reason: e.event === "draining" ? "draining" : String(e.reason) } }));
        close(false);
      }
    }));
    void sig.closed.then(() => close(false));

    for (const p of joined.producers) await consume(p);
    opts.video.srcObject = stream;
    opts.video.playsInline = true;
    // Autoplay with sound needs a user gesture; fall back to muted rather than not playing.
    opts.video.muted = !session.audio;
    await opts.video.play().catch(async () => {
      opts.video.muted = true;
      await opts.video.play().catch(() => undefined);
    });

    // keepAlive on activity, throttled.
    let last = 0;
    const alive = () => {
      if (closed || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
      const now = Date.now();
      if (now - last < Math.min(30_000, (session.idle_timeout_seconds * 1000) / 4)) return;
      last = now;
      // The API runs the idle timer (ADR 0049); the media plane has no keepAlive.
      void fetch(`${/\/v1$/.test(base) ? base : `${base}/v1`}/live/${encodeURIComponent(session.session_id)}/keepalive`, {
        method: "POST", headers: { authorization: `Bearer ${opts.apiKey}` },
      }).catch(() => undefined);
    };
    for (const name of ACTIVITY) {
      window.addEventListener(name, alive, { passive: true });
      cleanups.push(() => window.removeEventListener(name, alive));
    }
    document.addEventListener("visibilitychange", alive);
    cleanups.push(() => document.removeEventListener("visibilitychange", alive));
  } catch (err) {
    close(false);
    if (err instanceof SignallingError) throw new LiveError(err.code, err.message);
    throw err;
  }

  return {
    close: () => close(),
    async stats() {
      const video = [...consumers.values()].find((c) => c.kind === "video");
      if (!video || !transport) return {};
      let jitterMs: number | undefined;
      let rttMs: number | undefined;
      (await video.getStats()).forEach((r: Record<string, unknown>) => {
        if (r.type === "inbound-rtp" && typeof r.jitterBufferDelay === "number" && typeof r.jitterBufferEmittedCount === "number" && r.jitterBufferEmittedCount > 0) {
          jitterMs = (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000;
        }
      });
      (await transport.getStats()).forEach((r: Record<string, unknown>) => {
        if (r.type === "candidate-pair" && r.nominated && typeof r.currentRoundTripTime === "number") rttMs = r.currentRoundTripTime * 1000;
      });
      if (jitterMs === undefined && rttMs === undefined) return {};
      return { latencyMs: Math.round((jitterMs ?? 0) + (rttMs ?? 0) / 2) };
    },
  };
}
