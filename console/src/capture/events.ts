// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// What the capture page does with a server event (spec/media/signalling.md).
export type Reaction =
  | { action: "reconnect"; afterMs: number; message: string }
  | { action: "stop"; message: string }
  | { action: "notice"; message: string }
  | { action: "ignore" };

export function reactTo(e: { event: string; [k: string]: unknown }): Reaction {
  switch (e.event) {
    case "draining":
      return { action: "reconnect", afterMs: Number(e.reconnectAfterMs) || 1000, message: "Server restarting, reconnecting…" };
    case "roomClosed":
      // Never reconnect here: if two pages kept reclaiming the camera they would
      // kick each other off in a loop (newest connection replaces the old one).
      return {
        action: "stop",
        message: e.reason === "replaced" ? "This camera was opened on another device"
          : e.reason === "allowance_exhausted" ? "This account has used its camera time for now. Streaming resumes when the allowance resets or the plan changes."
          : e.reason === "resolution_not_in_plan" ? "This camera sends a higher resolution than this server records. Lower the camera's resolution and try again."
          : "This camera was closed by the server.",
      };
    case "producerClosed":
      return { action: "notice", message: "Recording stopped by the server. Press Resume to try again." };
    default:
      return { action: "ignore" };
  }
}

/** Wait before reconnect attempt `n` (0-based): 1 s doubling to 30 s, with jitter so many phones don't retry in step. */
export function retryDelay(n: number, rand: () => number = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** n);
  return Math.round(base / 2 + (rand() * base) / 2);
}

/**
 * Whether a failed connect is worth retrying by itself: the server or network was
 * away (a restart, a dropped connection). Not when the server said no (a revoked
 * link, a limit), which a retry can't fix.
 */
export function canRetry(err: unknown): boolean {
  const e = err as { code?: string; status?: number; name?: string };
  if (e?.name === "TypeError") return true; // fetch couldn't reach the API
  if (e?.code === "unreachable" || e?.code === "closed" || e?.code === "service_unavailable" || e?.code === "node_draining") return true;
  return typeof e?.status === "number" && (e.status >= 500 || e.status === 429);
}
