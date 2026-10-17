// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// A feed session's side of its callback (spec/media/callbacks.json): feed
// events in order, at least once, through a bounded queue; and `op` requests
// (upload_url, credentials) answered with JSON. Never logs a response body:
// an upload URL is a credential.
import { context, contextFromTraceparent, untraced } from "@senseplane/telemetry";
import { type Callback, type Log, permanent, post } from "../callbacks.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());

export class FeedCallback {
  private readonly queue: { body: string; event: string; key: string; tries: number; traceparent?: string }[] = [];
  private running?: Promise<void>;

  constructor(private readonly o: {
    callback: Callback; sessionId: string; room: string; log?: Log; fetch?: typeof fetch;
    timeoutMs?: number; attempts?: number; backoffMs?: number; maxPending?: number; now?: () => Date;
  }) {}

  get pending() {
    return this.queue.length;
  }

  /** Queues an event. Never throws, never waits. */
  emit(event: string, data: Record<string, unknown>, idempotencyKey: string, traceparent?: string) {
    const body = JSON.stringify({
      event, sentAt: (this.o.now?.() ?? new Date()).toISOString(), sessionId: this.o.sessionId, room: this.o.room, idempotencyKey, data,
    });
    if (this.queue.length >= (this.o.maxPending ?? 500)) {
      // Drop the oldest that is not in flight: a segment event is recoverable from the bucket.
      const dropped = this.queue.splice(1, 1)[0];
      this.o.log?.warn({ sessionId: this.o.sessionId, event: dropped?.event }, "feed callback queue full, dropping the oldest event");
    }
    this.queue.push({ body, event, key: idempotencyKey, tries: 0, ...(traceparent ? { traceparent } : {}) });
    this.kick();
  }

  private kick() {
    if (this.running) return;
    this.running = this.pump().finally(() => {
      this.running = undefined;
      if (this.queue.length) this.kick();
    });
  }

  private async pump() {
    const attempts = this.o.attempts ?? 5;
    while (this.queue.length) {
      const item = this.queue[0]!;
      let done = false;
      try {
        // A traced event (a segment upload) is sent inside its trace: the HTTP instrumentation carries it on as
        // traceparent. Everything else is sent untraced.
        const send = () => post(this.o.callback, item.body, this.o.timeoutMs ?? 5000, this.o.fetch);
        const tp = item.traceparent;
        const res = await (tp ? context.with(contextFromTraceparent(tp), send) : untraced(send));
        await res.arrayBuffer().catch(() => undefined);
        if (res.ok) done = true;
        else if (permanent(res.status)) {
          this.o.log?.warn({ sessionId: this.o.sessionId, event: item.event, status: res.status }, "feed callback refused an event, not retrying");
          done = true;
        }
      } catch {
        // network or timeout: retried
      }
      if (!done) {
        item.tries++;
        if (item.tries >= attempts) {
          this.o.log?.error({ sessionId: this.o.sessionId, event: item.event, key: item.key }, "feed callback gave up on an event");
        } else {
          await sleep((this.o.backoffMs ?? 500) * 2 ** (item.tries - 1));
          continue;
        }
      }
      if (this.queue[0] === item) this.queue.shift();
    }
  }

  /** Asks the caller something and reads its JSON answer (3 tries; a permanent refusal is final). */
  async request<T>(op: string, body: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify({ op, sessionId: this.o.sessionId, room: this.o.room, ...body });
    let last = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await post(this.o.callback, payload, this.o.timeoutMs ?? 5000, this.o.fetch);
        if (res.ok) return (await res.json()) as T;
        last = `callback answered ${res.status}`;
        await res.arrayBuffer().catch(() => undefined);
        if (permanent(res.status)) break;
      } catch (err) {
        last = (err as Error).name === "TimeoutError" ? "callback timed out" : (err as Error).message;
      }
      if (attempt < 3) await sleep((this.o.backoffMs ?? 500) * 2 ** (attempt - 1));
    }
    throw new Error(`the ${op} request to the callback failed: ${last}`);
  }

  /** Resolves once the queue is empty or the timeout passed. */
  async drain(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length && Date.now() < deadline) await sleep(20);
  }
}
