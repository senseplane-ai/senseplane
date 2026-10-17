// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// A signalling v1 client (spec/media/signalling.md) for server-side
// participants: the egress joins rooms with this, exactly like any client.
import WebSocket from "ws";

export class SignalError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
  }
}

export type EventFrame = { event: string; [k: string]: unknown };

export class SignalClient {
  private readonly ws: WebSocket;
  private next = 0;
  private readonly pending = new Map<number, { resolve: (d: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<(e: EventFrame) => void>();
  readonly opened: Promise<void>;
  /** Resolves when the socket closes, with its code and reason. */
  readonly closed: Promise<{ code: number; reason: string }>;
  private early: EventFrame[] = [];

  constructor(url: string, private readonly timeoutMs = 10_000) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", (err) => reject(new SignalError("unreachable", err.message)));
    });
    this.opened.catch(() => undefined);
    this.closed = new Promise((resolve) =>
      this.ws.on("close", (code, reason) => {
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new SignalError("closed", reason.toString() || "connection closed"));
        }
        this.pending.clear();
        resolve({ code, reason: reason.toString() });
      }),
    );
    this.ws.on("error", () => undefined);
    this.ws.on("message", (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof frame.event === "string") {
        if (!this.listeners.size) this.early.push(frame as EventFrame);
        for (const l of this.listeners) l(frame as EventFrame);
        return;
      }
      const p = this.pending.get(Number(frame.id));
      if (!p) return;
      this.pending.delete(Number(frame.id));
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.data);
      else p.reject(new SignalError(String(frame.code), typeof frame.message === "string" ? frame.message : undefined));
    });
  }

  /** Events, including any that arrived before the first listener. */
  onEvent(listener: (e: EventFrame) => void) {
    this.listeners.add(listener);
    const early = this.early;
    this.early = [];
    for (const e of early) listener(e);
    return () => this.listeners.delete(listener);
  }

  async request<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.opened;
    // A socket the media plane already closed answers nothing: say so now, not after the timeout.
    if (this.ws.readyState !== WebSocket.OPEN) throw new SignalError("closed", `${method}: the connection is closed`);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SignalError("timeout", `${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
      this.ws.send(JSON.stringify({ method, id, ...params }));
    });
  }

  /** join, then the `joined` event that follows its reply. */
  async join(token: string): Promise<EventFrame> {
    const joined = new Promise<EventFrame>((resolve) => {
      const off = this.onEvent((e) => {
        if (e.event === "joined") {
          off();
          resolve(e);
        }
      });
    });
    await this.request("join", { protocolVersion: 1, token });
    return joined;
  }

  close(code = 1000, reason = "client closed") {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code, reason);
  }
}
