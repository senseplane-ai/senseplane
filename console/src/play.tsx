// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Standalone player for a signed playback URL: play.html#u=<url>. Used by
// support links and the playback end-to-end check (e2e/m2-check.ts reads
// window.__playStartedMs).
import { createRoot } from "react-dom/client";
import { Player } from "./Player";
import "./styles/index.css";

declare global {
  interface Window {
    __playStartedMs?: number;
  }
}
const url = new URLSearchParams(location.hash.slice(1)).get("u") ?? "";
createRoot(document.getElementById("root")!).render(
  url ? <Player url={url} onStarted={(ms) => (window.__playStartedMs = ms)} /> : <p style={{ color: "#fff" }}>No playback URL.</p>,
);
