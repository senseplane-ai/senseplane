// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Phone/laptop capture page. Opened from a QR code with no login: the URL
// fragment carries a capture ticket (t), the API base URL (a) and the source
// name (n). The ticket is exchanged for a short-lived media join token on every
// connect, then the page speaks signalling protocol v1 over a WebSocket (ADR 0017).
import { ConnectTimings, newTraceparent, traceEnabled } from "./trace";
import { Device } from "mediasoup-client";
import type { Producer, RtpCapabilities, Transport, TransportOptions } from "mediasoup-client/types";
import { reactTo } from "./events";
import { PROTOCOL_VERSION, SignallingClient } from "./signalling";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLParagraphElement>("status");
const indicator = $<HTMLSpanElement>("indicator");
const toggleBtn = $<HTMLButtonElement>("toggle");
const stopBtn = $<HTMLButtonElement>("stop");
const preview = $<HTMLVideoElement>("preview");

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
async function getJoinToken(): Promise<{ token: string; url: string; max_resolution?: "720p" | "1080p" }> {
  const res = await fetch(`${apiUrl}/v1/capture/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket, device: deviceKey() }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `could not start (${res.status})`);
  return json;
}

/** The account's maximum size (ADR 0022): the media plane refuses anything larger rather than transcoding. */
export function captureSize(plan: "720p" | "1080p") {
  const [w, h] = plan === "1080p" ? [1920, 1080] : [1280, 720];
  return { width: { ideal: w, max: w }, height: { ideal: h, max: w } };
}
let plan: "720p" | "1080p" = "720p";

let stream: MediaStream | undefined;
let transport: Transport | undefined;
let signalling: SignallingClient | undefined;
let producers: Producer[] = [];
let wakeLock: WakeLockSentinel | undefined;
let state: "idle" | "live" | "paused" | "stopped" = "idle";

const setStatus = (text: string) => (statusEl.textContent = text);

async function holdWakeLock() {
  try {
    if ("wakeLock" in navigator && document.visibilityState === "visible") wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    /* not supported or denied: the page still works while the screen stays on */
  }
}

async function start() {
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
  const grants = (snapshot.grants ?? {}) as { publishKinds?: string[] };
  const recordAudio = (grants.publishKinds ?? []).includes("audio");
  sig.onEvent((e) => {
    const r = reactTo(e);
    if (r.action === "reconnect") {
      setStatus(r.message);
      void halt("paused", false).then(() => setTimeout(() => void start().catch(fail), r.afterMs));
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
    if (s === "failed" || s === "disconnected") setStatus("Connection lost. Press Resume to reconnect.");
  });

  const video = stream.getVideoTracks()[0]!;
  video.contentHint = "detail"; // keep resolution, drop frame rate under load (ADR 0014)
  const h264 = device.rtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === "video/h264");
  if (!h264) throw new Error("This browser cannot send H.264 video.");
  producers = [await transport.produce({ track: video, codec: h264, encodings: [{ maxBitrate: plan === "1080p" ? 3_000_000 : 1_500_000 }], appData: { source: "camera" } })];
  const audio = stream.getAudioTracks()[0];
  if (audio) producers.push(await transport.produce({ track: audio, appData: { source: "microphone" } }));

  await holdWakeLock();
  state = "live";
  indicator.hidden = false;
  toggleBtn.textContent = "Pause";
  toggleBtn.disabled = false;
  stopBtn.disabled = false;
  setStatus(recordAudio ? "Recording video and audio" : "Recording video");
}

async function halt(next: "paused" | "stopped", notify = true) {
  toggleBtn.disabled = true;
  stopBtn.disabled = true;
  // `leave` first, so the media plane finalises the open segment while media still flows.
  if (notify) await signalling?.request("leave").catch(() => {});
  signalling?.close();
  signalling = undefined;
  for (const p of producers) p.close();
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
