// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The live demo (website /try page): no API key. Hand-written because the
// event stream is Server-Sent Events read over fetch (the session token goes
// in a header, never in the URL), which a generated client doesn't do.
import type { components } from "./generated/schema.js";
import { SenseplaneError } from "./errors.js";
import { readSse } from "./sse.js";

type S = components["schemas"];
export type DemoSession = S["DemoSession"];
export type DemoAnswer = { answer: string; from: "live" | "memory"; confidence?: number; snapshot_url?: string; event?: S["Event"] };
export type DemoStreamHandlers = {
  status?: (s: { camera: "pending" | "online" | "offline" }) => void;
  event?: (e: S["Event"]) => void;
  snapshot?: (s: { url: string; captured_at: string }) => void;
  ended?: (e: { reason: string }) => void;
};

async function json<T>(res: Response): Promise<T> {
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body as S["Error"]).error;
    throw new SenseplaneError(res.status, e?.code ?? "unknown", e?.message ?? res.statusText, e?.request_id);
  }
  return body as T;
}

export class SenseplaneDemo {
  constructor(private readonly baseUrl = "https://api.senseplane.com/v1", private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  start(): Promise<DemoSession> {
    return this.fetchImpl(`${this.baseUrl}/demo/sessions`, { method: "POST" }).then((r) => json<DemoSession>(r));
  }

  ask(session: Pick<DemoSession, "id" | "token">, question: string): Promise<DemoAnswer> {
    return this.fetchImpl(`${this.baseUrl}/demo/sessions/${session.id}/ask`, {
      method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ question }),
    }).then((r) => json<DemoAnswer>(r));
  }

  end(session: Pick<DemoSession, "id" | "token">): Promise<void> {
    return this.fetchImpl(`${this.baseUrl}/demo/sessions/${session.id}`, { method: "DELETE", headers: { authorization: `Bearer ${session.token}` } }).then((r) => json<void>(r));
  }

  /** Reads the live stream until it ends or `signal` aborts. */
  async stream(session: Pick<DemoSession, "id" | "token">, on: DemoStreamHandlers, signal?: AbortSignal): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/demo/sessions/${session.id}/events`, {
      headers: { authorization: `Bearer ${session.token}`, accept: "text/event-stream" }, signal,
    });
    if (!res.ok || !res.body) await json(res);
    for await (const { event, data } of readSse(res)) {
      (on as Record<string, ((p: unknown) => void) | undefined>)[event]?.(data);
      if (event === "ended") return;
    }
  }
}
