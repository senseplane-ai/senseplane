// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Dev-only driver for live-test.html (e2e/live-check.ts): opens a live view
// and exposes what the check needs on window.__liveTest.
import { LiveError, openLive, type LiveView } from "./client";

const params = new URLSearchParams(location.hash.slice(1));
const video = document.getElementById("video") as HTMLVideoElement;
const status = document.getElementById("status")!;

const state = {
  phase: "starting" as "starting" | "live" | "closed" | "error",
  startedAt: performance.now(),
  /** ms from openLive() to the first decoded video frame. */
  firstFrameMs: undefined as number | undefined,
  frames: 0,
  error: undefined as string | undefined,
  closedReason: undefined as string | undefined,
  tracks: () => {
    const s = video.srcObject as MediaStream | null;
    return { video: s?.getVideoTracks().length ?? 0, audio: s?.getAudioTracks().length ?? 0 };
  },
  view: undefined as LiveView | undefined,
};
(window as unknown as { __liveTest: typeof state }).__liveTest = state;

const onFrame = () => {
  state.frames++;
  state.firstFrameMs ??= Math.round(performance.now() - state.startedAt);
  status.textContent = `live: ${state.frames} frames, first after ${state.firstFrameMs} ms`;
  if (state.phase === "live") video.requestVideoFrameCallback(onFrame);
};

video.addEventListener("senseplane:liveclosed", (e) => {
  state.closedReason = (e as CustomEvent<{ reason: string }>).detail.reason;
  state.phase = "closed";
  status.textContent = `closed: ${state.closedReason}`;
});

try {
  state.view = await openLive({
    apiUrl: params.get("a") ?? "", apiKey: params.get("k") ?? "", sourceId: params.get("s") ?? "", video, audio: params.get("audio") === "1",
  });
  state.phase = "live";
  video.requestVideoFrameCallback(onFrame);
} catch (err) {
  state.phase = "error";
  state.error = err instanceof LiveError ? err.code : String(err);
  status.textContent = `error: ${state.error}`;
}
