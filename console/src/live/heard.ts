// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Whether the camera hears a press of push-to-talk (ADR 0069, 0074). The
// media plane says `talkbackListening` once the camera's speaker gets the
// track (the phone playing it, or the box connected to the camera), and
// `talkbackEnded` when it ended the press itself (the box couldn't reach the
// speaker, the camera hung up, ten minutes passed). For a camera behind a
// box, a press nobody hears within a few seconds is ended here: never a
// microphone open to no one. A phone's press is as it always was: no wait.

export type TalkState =
  | { state: "connecting" }
  | { state: "listening" }
  | { state: "ended"; reason: string; message: string };

/** Words for why a press ended, for the person holding the button. */
export function endedText(reason: string, message?: string): string {
  if (message) return message;
  switch (reason) {
    case "no_listener":
      return "The camera's speaker didn't answer, so nobody heard you. Its box may be offline.";
    case "listener_left":
      return "The camera stopped getting your audio (its box went away, the camera hung up, or nothing reached it for a few seconds).";
    case "expired":
      return "Push-to-talk stops after 10 minutes. Press again to keep talking.";
    default:
      return "The camera stopped playing what you said.";
  }
}

export function createHeard(opts: { timeoutMs?: number; onEnd: () => void; /** Wait for the camera's word (a box); false: a phone. */ confirm?: boolean }) {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const confirm = opts.confirm !== false;
  const listeners = new Set<(s: TalkState) => void>();
  /** Listening events that came before the press's own reply. */
  const early = new Set<string>();
  let current: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const emit = (s: TalkState) => {
    for (const fn of listeners) fn(s);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const end = (reason: string, message?: string) => {
    clear();
    current = undefined;
    emit({ state: "ended", reason, message: endedText(reason, message) });
    opts.onEnd();
  };
  return {
    /** A press's track exists on the media plane. */
    press(producerId: string) {
      clear();
      current = producerId;
      if (early.delete(producerId) || !confirm) return emit({ state: "listening" });
      emit({ state: "connecting" });
      timer = setTimeout(() => current === producerId && end("no_listener"), timeoutMs);
    },
    /** The person let go. */
    release() {
      clear();
      current = undefined;
      early.clear();
    },
    /** A signalling event. */
    event(e: Record<string, unknown>) {
      const id = String(e.producerId ?? "");
      if (e.event === "talkbackListening") {
        if (id !== current) {
          early.add(id);
          return;
        }
        clear();
        emit({ state: "listening" });
      } else if (e.event === "talkbackEnded" && id && id === current) {
        end(String(e.reason ?? "ended"), typeof e.message === "string" ? e.message : undefined);
      }
    },
    subscribe(fn: (s: TalkState) => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    close() {
      clear();
      listeners.clear();
    },
  };
}
