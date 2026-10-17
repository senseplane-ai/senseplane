// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Minimal client for media signalling protocol v1 (spec/media/signalling.md):
// requests {method, id} → one reply {id, ok, data | code}; events {event}.
export const PROTOCOL_VERSION = 1;

export class SignallingError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
  }
}

type Event = { event: string; [k: string]: unknown };

export class SignallingClient {
  private ws: WebSocket;
  private next = 0;
  private pending = new Map<number, { resolve: (d: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(e: Event) => void>();
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new SignallingError("unreachable", "could not reach the media server")), { once: true });
    });
    this.closed = new Promise((resolve) =>
      this.ws.addEventListener("close", (e) => {
        for (const p of this.pending.values()) p.reject(new SignallingError("closed", e.reason || "connection closed"));
        this.pending.clear();
        resolve({ code: e.code, reason: e.reason });
      }),
    );
    this.ws.addEventListener("message", (msg) => {
      const frame = JSON.parse(String(msg.data));
      if ("event" in frame) return this.listeners.forEach((l) => l(frame));
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.data);
      else p.reject(new SignallingError(frame.code, frame.message));
    });
  }

  onEvent(listener: (e: Event) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the next event of that name. */
  nextEvent(name: string): Promise<Event> {
    return new Promise((resolve) => {
      const off = this.onEvent((e) => {
        if (e.event === name) {
          off();
          resolve(e);
        }
      });
    });
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.opened;
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject });
      this.ws.send(JSON.stringify({ method, id, ...params }));
    });
  }

  close() {
    this.ws.close(1000, "client closed");
  }
}
