// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Optional browser-side tracing for the capture page (ADR 0033), off by
// default. When built with VITE_TRACE_SIGNALLING=1, the page starts a trace
// (a W3C traceparent sent with `join`, so the media node's spans for this
// session join it) and reports its WebRTC connect timings, in milliseconds,
// with `produce`. Nothing else is sent; no browser telemetry SDK is loaded.

export const traceEnabled = import.meta.env?.VITE_TRACE_SIGNALLING === "1";

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");

/** A sampled W3C traceparent for a new trace started by this page. */
export function newTraceparent(): string {
  return `00-${hex(16)}-${hex(8)}-01`;
}

/** Connect timings relative to when the page started connecting. */
export class ConnectTimings {
  private readonly t0 = performance.now();
  private readonly marks: Record<string, number> = {};

  mark(name: "ws_open_ms" | "join_ms" | "transport_connected_ms" | "first_produce_ms") {
    this.marks[name] ??= Math.round(performance.now() - this.t0);
  }

  get values(): Record<string, number> {
    return { ...this.marks };
  }
}
