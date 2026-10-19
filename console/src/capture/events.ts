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
