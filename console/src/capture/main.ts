// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Phone/laptop capture page. Opened from a QR code with no login: the URL
// fragment carries a capture ticket (t), the API base URL (a) and the source
// name (n). The ticket is exchanged for a short-lived media join token on every
// connect, then the page speaks signalling protocol v1 over a WebSocket (ADR 0017).
// It is also the camera's speaker (ADR 0069): it plays a person's push-to-talk
// and agents' messages, and says so on screen while they play.
import { ConnectTimings, newTraceparent, traceEnabled } from "./trace";
import { Device } from "mediasoup-client";
import type { Consumer, Producer, RtpCapabilities, RtpParameters, Transport, TransportOptions } from "mediasoup-client/types";
import { canRetry, reactTo, retryDelay } from "./events";
import { PhoneSpeaker, type Sound, speakingText } from "./speaker";
import { PROTOCOL_VERSION, SignallingClient } from "./signalling";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLParagraphElement>("status");
const indicator = $<HTMLSpanElement>("indicator");
const toggleBtn = $<HTMLButtonElement>("toggle");
const stopBtn = $<HTMLButtonElement>("stop");
const preview = $<HTMLVideoElement>("preview");
const speakingEl = $<HTMLParagraphElement>("speaking");
const allowSound = $<HTMLButtonElement>("allow-sound");

const params = new URLSearchParams(location.hash.slice(1));
const ticket = params.get("t") ?? "";
const apiUrl = (params.get("a") ?? "").replace(/\/$/, "");
$<HTMLSpanElement>("source-name").textContent = params.get("n") ?? "";

/**
 * A random key kept on this device. The first join binds the capture link to it,
 * so a leaked link or QR code can't take over the camera from another device (ADR 0038).
 */
export function deviceKey(storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage): string {
  const name = "senseplane-device-key";
  try {
    const existing = storage?.getItem(name);
    if (existing && existing.length >= 16) return existing;
  } catch {
    /* storage unavailable (private mode): fall back to a per-page key */
  }
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  try {
    storage?.setItem(name, key);
  } catch {
    /* ignore */
  }
  return key;
}

/** Exchanges the capture ticket for a join token and the signalling URL. */
async function getJoinToken(): Promise<{ token: string; url: string; max_resolution?: "720p" | "1080p" | "1440p" }> {
  const res = await fetch(`${apiUrl}/v1/capture/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket, device: deviceKey() }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? `could not start (${res.status})`), { status: res.status, code: json?.error?.code });
  return json;
}

/** The account's maximum size (ADR 0022): the media plane refuses anything larger rather than transcoding. */
export function captureSize(plan: "720p" | "1080p" | "1440p") {
  // A phone asks for 1080p at most: 1440p is there for IP cameras that only send 2K or 3 MP.
  const [w, h] = plan === "720p" ? [1280, 720] : [1920, 1080];
  return { width: { ideal: w, max: w }, height: { ideal: h, max: w } };
}
let plan: "720p" | "1080p" | "1440p" = "720p";

let stream: MediaStream | undefined;
let transport: Transport | undefined;
let signalling: SignallingClient | undefined;
let producers: Producer[] = [];
let wakeLock: WakeLockSentinel | undefined;
let recv: Transport | undefined;
const talkConsumers = new Map<string, Consumer>();
/** Plays a person's push-to-talk track, once the page is publishing. */
let hearTalkNow: ((producerId: string) => Promise<void>) | undefined;

// Whatever comes out of the speaker is shown on screen, so people near the phone know.
const speaker = new PhoneSpeaker({
  apiUrl,
  clipSound: (url) => new Audio(url) as unknown as Sound,
  onChange: (s) => {
    speakingEl.textContent = speakingText(s);
    speakingEl.hidden = !s;
  },
  onBlocked: () => (allowSound.hidden = false),
});
allowSound.addEventListener("click", () => {
  // A tap lets the browser play sound from now on.
  void new Audio().play().catch(() => undefined);
  allowSound.hidden = true;
});
let state: "idle" | "live" | "paused" | "stopped" = "idle";

const setStatus = (text: string) => (statusEl.textContent = text);

// Reconnecting by itself after a server restart or a dropped connection, until it works or the user stops.
let attempt = 0;
let reconnecting = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let lostTimer: ReturnType<typeof setTimeout> | undefined;

function cancelRetry() {
  clearTimeout(retryTimer);
  clearTimeout(lostTimer);
  retryTimer = lostTimer = undefined;
  reconnecting = false;
}

function reconnectSoon(message: string, minMs = 0) {
  if (state === "stopped" || reconnecting) return; // a drop often trips several signals at once
  reconnecting = true;
  const wait = Math.max(minMs, retryDelay(attempt++));
  void halt("paused", false).then(() => {
    if (!reconnecting || state !== "paused") return;
    setStatus(`${message} Reconnecting in ${Math.ceil(wait / 1000)} s…`);
    retryTimer = setTimeout(() => void start().catch(fail), wait);
  });
}

async function holdWakeLock() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    /* not supported or denied: the page still works while the screen stays on */
  }
}

async function start() {
  cancelRetry();
  setStatus("Connecting…");
  const { token, url, max_resolution } = await getJoinToken();
  plan = max_resolution ?? "720p";
  const sig = new SignallingClient(url);
  signalling = sig;
  // Off by default: a traceparent and connect timings only with VITE_TRACE_SIGNALLING=1 (trace.ts).
  const timings = traceEnabled ? new ConnectTimings() : undefined;
  const joined = sig.nextEvent("joined");
  await sig.request("join", { protocolVersion: PROTOCOL_VERSION, token, ...(traceEnabled ? { traceparent: newTraceparent() } : {}) });
  timings?.mark("join_ms");
  const snapshot = await joined;
  const grants = (snapshot.grants ?? {}) as { publishKinds?: string[]; canSubscribe?: boolean };
  const recordAudio = (grants.publishKinds ?? []).includes("audio");
  sig.onEvent((e) => {
    if (speaker.onEvent(e)) return;
    if ((e.event === "producerAppeared" || e.event === "newProducer") && e.source === "talkback") {
      void hearTalkNow?.(String(e.producerId)).catch(() => undefined);
      return;
    }
    if (e.event === "producerClosed" && e.consumerId) {
      talkConsumers.get(String(e.producerId))?.close();
      talkConsumers.delete(String(e.producerId));
      speaker.personStopped(String(e.producerId));
      return;
    }
    const r = reactTo(e);
    if (r.action === "reconnect") {
      reconnectSoon(r.message, r.afterMs);
    } else if (r.action === "stop") {
      void halt("stopped", false).then(() => setStatus(r.message));
    } else if (r.action === "notice" && state === "live") {
      setStatus(r.message);
    }
  });


  setStatus("Asking for camera access…");
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", ...captureSize(plan), frameRate: { ideal: 15, max: 30 } },
    // A camera listens for crying, glass and alarms: the browser's call processing (noise suppression,
    // echo cancellation, gain control) would filter exactly those out.
    audio: recordAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
  });
  preview.srcObject = stream;

  const device = new Device();
  await device.load({ routerRtpCapabilities: snapshot.routerRtpCapabilities as RtpCapabilities });
  // `transportId` is the contract's name (spec/media/signalling.md); `id` is accepted too.
  const params = await sig.request<TransportOptions & { transportId?: string }>("createTransport", { direction: "send" });
  transport = device.createSendTransport({ ...params, id: params.transportId ?? params.id });
  const transportId = transport.id;
  transport.on("connect", ({ dtlsParameters }, ok, fail) =>
    sig.request("connectTransport", { transportId, dtlsParameters }).then(() => {
      timings?.mark("transport_connected_ms");
      ok();
    }, fail),
  );
  transport.on("produce", ({ kind, rtpParameters, appData }, ok, fail) => {
    timings?.mark("first_produce_ms");
    const extra = timings ? { timings: timings.values } : {};
    sig.request<{ producerId: string }>("produce", { transportId, kind, rtpParameters, appData, ...extra }).then(({ producerId }) => ok({ id: producerId }), fail);
  });
  transport.on("connectionstatechange", (s) => {
    if (s === "connected") clearTimeout(lostTimer);
    // "disconnected" often recovers by itself within a few seconds; "failed" doesn't.
    else if (s === "failed") reconnectSoon("Connection lost.");
    else if (s === "disconnected") {
      clearTimeout(lostTimer);
      lostTimer = setTimeout(() => reconnectSoon("Connection lost."), 5000);
    }
  });
  // The media server went away without saying so (a crash or a hard restart).
  void sig.closed.then(() => {
    if (signalling === sig && state === "live") reconnectSoon("Lost the media server.");
  });

  const video = stream.getVideoTracks()[0]!;
  video.contentHint = "detail"; // keep resolution, drop frame rate under load (ADR 0014)
  const h264 = device.rtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === "video/h264");
  if (!h264) throw new Error("This browser cannot send H.264 video.");
  producers = [await transport.produce({ track: video, codec: h264, encodings: [{ maxBitrate: plan === "720p" ? 1_500_000 : 3_000_000 }], appData: { source: "camera" } })];
  const audio = stream.getAudioTracks()[0];
  if (audio) producers.push(await transport.produce({ track: audio, appData: { source: "microphone" } }));

  /** A person's push-to-talk (ADR 0069): consume their track and play it. */
  const hearTalk = async (producerId: string) => {
    if (!grants.canSubscribe || talkConsumers.has(producerId)) return;
    if (!recv) {
      const p = await sig.request<TransportOptions & { transportId?: string }>("createTransport", { direction: "recv" });
      const t = device.createRecvTransport({ ...p, id: p.transportId ?? p.id });
      t.on("connect", ({ dtlsParameters }, ok, fail) => sig.request("connectTransport", { transportId: t.id, dtlsParameters }).then(() => ok(), fail));
      recv = t;
    }
    const c = await sig.request<{ consumerId: string; producerId: string; kind: "audio" | "video"; rtpParameters: RtpParameters }>("consume", {
      transportId: recv.id, producerId, rtpCapabilities: device.recvRtpCapabilities,
    });
    const consumer = await recv.consume({ id: c.consumerId, producerId: c.producerId, kind: c.kind, rtpParameters: c.rtpParameters });
    talkConsumers.set(producerId, consumer);
    await sig.request("resumeConsumer", { consumerId: c.consumerId });
    const el = new Audio();
    el.srcObject = new MediaStream([consumer.track]);
    speaker.personStarted(producerId, el as unknown as Sound);
  };
  hearTalkNow = hearTalk;
  for (const p of (snapshot.producers ?? []) as { producerId: string; source?: string }[]) {
    if (p.source === "talkback") void hearTalk(p.producerId).catch(() => undefined);
  }

  await holdWakeLock();
  attempt = 0;
  state = "live";
  indicator.hidden = false;
  toggleBtn.textContent = "Pause";
  toggleBtn.disabled = false;
  stopBtn.disabled = false;
  setStatus(recordAudio ? "Recording video and audio" : "Recording video");
}

async function halt(next: "paused" | "stopped", notify = true) {
  if (next === "stopped" || notify) cancelRetry();
  toggleBtn.disabled = true;
  stopBtn.disabled = true;
  // `leave` first, so the media plane finalises the open segment while media still flows.
  if (notify) await signalling?.request("leave").catch(() => {});
  signalling?.close();
  signalling = undefined;
  for (const p of producers) p.close();
  speaker.stopAll();
  for (const c of talkConsumers.values()) c.close();
  talkConsumers.clear();
  recv?.close();
  recv = undefined;
  hearTalkNow = undefined;
  transport?.close();
  stream?.getTracks().forEach((t) => t.stop());
  await wakeLock?.release().catch(() => {});
  producers = [];
  state = next;
  indicator.hidden = true;
  preview.srcObject = null;
  if (next === "paused") {
    toggleBtn.textContent = "Resume";
    toggleBtn.disabled = false;
    stopBtn.disabled = false;
    setStatus("Paused. Nothing is being recorded.");
  } else {
    setStatus("Stopped. You can close this page.");
  }
}

toggleBtn.addEventListener("click", () => {
  if (state === "live") void halt("paused");
  else if (state === "paused") void start().catch(fail);
});
stopBtn.addEventListener("click", () => void halt("stopped"));
document.addEventListener("visibilitychange", () => {
  if (state !== "live") return;
  if (document.visibilityState === "visible") void holdWakeLock();
  else setStatus("Keep this page open and the screen on: browsers pause the camera in the background.");
});
function fail(err: unknown) {
  const e = err as Error & { code?: string };
  if (state !== "stopped" && canRetry(err)) return reconnectSoon("Can't reach the server.");
  // The account's streaming-camera limit (ADR 0025), from the API at join or the media plane at produce.
  if (e.code === "source_limit_reached" || /camera limit/.test(e.message ?? "")) setStatus("This account's camera limit is reached. Stop another camera, then try again.");
  else if (e.code === "allowance_exhausted") setStatus("This account has used its camera time for now. Streaming resumes when the allowance resets or the plan changes.");
  else setStatus(`Could not start: ${e.message ?? err}`);
  toggleBtn.textContent = "Try again";
  state = "paused";
  toggleBtn.disabled = false;
}

if (!ticket || !apiUrl) setStatus("This link is incomplete. Create a new capture link in the console.");
else if (!window.isSecureContext) setStatus("This page needs HTTPS to use the camera.");
else void start().catch(fail);

declare global {
  interface Window {
    __senseplaneCapture?: { state: () => string };
  }
}
window.__senseplaneCapture = { state: () => state };
