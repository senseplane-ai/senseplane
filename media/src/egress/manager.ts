// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The egress role: the feed sessions this host runs, idempotent per sessionId.
import { context, trace } from "@senseplane/telemetry";
import type { Log } from "../callbacks.js";
import { type FeedDeps, FeedSession } from "./feed.js";
import type { EgressStart } from "./validate.js";

export type Answer = { status: number; body: unknown };

/** Terminal sessions are remembered this long, so a retried stop or status still answers. */
const FORGET_AFTER_MS = 10 * 60_000;

export class EgressManager {
  readonly sessions = new Map<string, FeedSession>();
  private readonly pruner: NodeJS.Timeout;

  constructor(private readonly deps: FeedDeps & { maxSessions: number; log: Log }) {
    this.pruner = setInterval(() => this.prune(), 60_000);
    this.pruner.unref();
  }

  live(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (!s.terminal) n++;
    return n;
  }

  async start(job: EgressStart): Promise<Answer> {
    const existing = this.sessions.get(job.sessionId);
    // Idempotent: a retry must not start a second recorder for one camera.
    if (existing) return { status: 200, body: existing.snapshot() };
    if (this.live() >= this.deps.maxSessions) return { status: 503, body: { error: "no egress has capacity" } };
    const session = new FeedSession(job, this.deps);
    this.sessions.set(job.sessionId, session);
    try {
      // Detached from the start request's trace: a camera's feed runs for days, and its callbacks
      // start traces of their own (a sampled frames batch, a segment upload).
      await context.with(trace.deleteSpan(context.active()), () => session.start());
      return { status: 201, body: session.snapshot() };
    } catch (err) {
      this.sessions.delete(job.sessionId);
      this.deps.log.error({ err, sessionId: job.sessionId }, "egress session failed to start");
      return { status: 500, body: { error: "could not start the session", detail: (err as Error).message } };
    }
  }

  get(id: string): Answer {
    const s = this.sessions.get(id);
    return s ? { status: 200, body: s.snapshot() } : { status: 404, body: { error: "no such session" } };
  }

  list(room: string): Answer {
    return { status: 200, body: { sessions: [...this.sessions.values()].filter((s) => s.job.room === room).map((s) => s.snapshot()) } };
  }

  /** Idempotent: a terminal session answers its terminal snapshot; a slow teardown answers 202. */
  async stop(id: string): Promise<Answer> {
    const s = this.sessions.get(id);
    if (!s) return { status: 404, body: { error: "no such session" } };
    if (s.terminal) return { status: 200, body: s.snapshot() };
    const done = s.stop("requested");
    const finished = await Promise.race([done.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000).unref())]);
    return { status: finished ? 200 : 202, body: s.snapshot() };
  }

  private prune(now = Date.now()) {
    for (const [id, s] of this.sessions) if (s.terminal && s.endedAt && now - Date.parse(s.endedAt) > FORGET_AFTER_MS) this.sessions.delete(id);
  }

  async close() {
    clearInterval(this.pruner);
    await Promise.allSettled([...this.sessions.values()].map((s) => s.stop("shutdown")));
  }
}
