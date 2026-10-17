// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  sessionStorage.clear();
  localStorage.clear();
});

// jsdom has no media playback or matchMedia.
if (typeof HTMLMediaElement !== "undefined") {
  HTMLMediaElement.prototype.play = function play() { return Promise.resolve(); };
  HTMLMediaElement.prototype.pause = function pause() {};
}
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}
window.scrollTo = (() => {}) as typeof window.scrollTo;
