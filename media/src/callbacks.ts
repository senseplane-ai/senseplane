// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Room callbacks (spec/media/callbacks.json): participant and producer events
// for rooms that ask for them, and room.ended for every room with a callback.
// At least once, from wherever the thing happened, never in the media path:
// a send never throws or waits for the caller, retries are bounded, and past
// the queue bound the oldest pending delivery is dropped (the receiver can
// recover room state from GET /control/rooms/{room}).
export type Callback = { url: string; token: string };
export type Log = { info(o: object, m: string): void; warn(o: object, m: string): void; error(o: object, m: string): void };

export const ROOM_EVENT_TYPES = ["participant.joined", "participant.left", "producer.added", "producer.removed"] as const;
export type RoomEventType = (typeof ROOM_EVENT_TYPES)[number];

/** A 4xx other than 408/429 is the receiver refusing, and asking again will be refused again. */
export const permanent = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

export async function post(cb: Callback, body: string | FormData, timeoutMs: number, fetchImpl: typeof fetch = fetch, extra: Record<string, string> = {}): Promise<Response> {
  return fetchImpl(cb.url, {
    method: "POST",
    headers: { authorization: `Bearer ${cb.token}`, ...(typeof body === "string" ? { "content-type": "application/json" } : {}), ...extra },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref?.());

export class RoomEvents {
  private readonly inFlight = new Set<{ cancelled: boolean; done: Promise<void> }>();

  constructor(private readonly o: {
    log?: Log; fetch?: typeof fetch; timeoutMs?: number; attempts?: number; retryBaseMs?: number; maxPending?: number; now?: () => Date;
  } = {}) {}

  get pending() {
    return this.inFlight.size;
  }

  /** Room events: {roomId, event, at, idempotencyKey, data}. */
  event(roomId: string, cb: Callback | null | undefined, wanted: readonly string[] | undefined, event: RoomEventType, data: Record<string, unknown>, idempotencyKey: string) {
    if (!cb || !wanted?.includes(event)) return;
    this.send(cb, { roomId, event, at: (this.o.now?.() ?? new Date()).toISOString(), idempotencyKey, data }, { roomId, event });
  }

  /** room.ended: {roomId, event, at, reason}; deduped by the receiver on (roomId, event). */
  ended(roomId: string, cb: Callback | null | undefined, at: Date, reason: string) {
    if (!cb) return;
    this.send(cb, { roomId, event: "room.ended", at: at.toISOString(), reason }, { roomId, event: "room.ended" });
  }

  private send(cb: Callback, body: object, meta: { roomId: string; event: string }) {
    const max = this.o.maxPending ?? 2000;
    if (this.inFlight.size >= max) {
      const oldest = this.inFlight.values().next().value;
      if (oldest) {
        oldest.cancelled = true;
        this.inFlight.delete(oldest);
      }
      this.o.log?.warn(meta, "room callback backlog full, dropping the oldest delivery");
    }
    const handle = { cancelled: false, done: Promise.resolve() };
    handle.done = this.deliver(cb, JSON.stringify(body), handle, meta).finally(() => this.inFlight.delete(handle));
    this.inFlight.add(handle);
  }

  private async deliver(cb: Callback, body: string, handle: { cancelled: boolean }, meta: { roomId: string; event: string }) {
    const attempts = this.o.attempts ?? 4;
    for (let attempt = 1; attempt <= attempts && !handle.cancelled; attempt++) {
      try {
        const res = await post(cb, body, this.o.timeoutMs ?? 5000, this.o.fetch);
        await res.arrayBuffer().catch(() => undefined);
        if (res.ok) return;
        if (permanent(res.status)) {
          this.o.log?.warn({ ...meta, status: res.status }, "room callback refused, not retrying");
          return;
        }
      } catch {
        // network error or timeout: retried
      }
      if (attempt === attempts) {
        this.o.log?.warn(meta, "room callback failed, giving up");
        return;
      }
      await sleep((this.o.retryBaseMs ?? 500) * 4 ** (attempt - 1));
    }
  }

  /** Resolves once every delivery in flight is done (tests, shutdown). */
  async settled() {
    await Promise.allSettled([...this.inFlight].map((h) => h.done));
  }
}
