// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// Whether the camera hears a press of push-to-talk (ADR 0074).
import { afterEach, describe, expect, it, vi } from "vitest";
import { type TalkState, createHeard, endedText } from "./heard";

afterEach(() => vi.useRealTimers());

const watch = (timeoutMs = 6000) => {
  const states: TalkState[] = [];
  let ended = 0;
  const h = createHeard({ timeoutMs, onEnd: () => void ended++ });
  h.subscribe((s) => states.push(s));
  return { h, states, ended: () => ended };
};

describe("push-to-talk: is the camera hearing it", () => {
  it("connects, then hears", () => {
    const { h, states, ended } = watch();
    h.press("p1");
    h.event({ event: "talkbackListening", producerId: "p1" });
    expect(states).toEqual([{ state: "connecting" }, { state: "listening" }]);
    expect(ended()).toBe(0);
  });

  it("takes a listening event that came before the press's reply", () => {
    const { h, states } = watch();
    h.event({ event: "talkbackListening", producerId: "p1" });
    h.press("p1");
    expect(states).toEqual([{ state: "listening" }]);
  });

  it("stops a press nobody hears within a few seconds", () => {
    vi.useFakeTimers();
    const { h, states, ended } = watch(6000);
    h.press("p1");
    vi.advanceTimersByTime(5999);
    expect(ended()).toBe(0);
    vi.advanceTimersByTime(2);
    expect(ended()).toBe(1);
    expect(states.at(-1)).toMatchObject({ state: "ended", reason: "no_listener", message: expect.stringMatching(/didn't answer/) });
  });

  it("doesn't time out a press that was heard or released", () => {
    vi.useFakeTimers();
    const { h, ended } = watch(1000);
    h.press("p1");
    h.event({ event: "talkbackListening", producerId: "p1" });
    vi.advanceTimersByTime(5000);
    h.press("p2");
    h.release();
    vi.advanceTimersByTime(5000);
    expect(ended()).toBe(0);
  });

  it("leaves a phone's press as it was: heard at once, never timed out", () => {
    vi.useFakeTimers();
    const states: TalkState[] = [];
    let ended = 0;
    const h = createHeard({ timeoutMs: 1000, onEnd: () => void ended++, confirm: false });
    h.subscribe((s) => states.push(s));
    h.press("p1");
    vi.advanceTimersByTime(10_000);
    expect(states).toEqual([{ state: "listening" }]);
    expect(ended).toBe(0);
  });

  it("ends the press when the camera's side does, with its words, and ignores another press's events", () => {
    const { h, states, ended } = watch();
    h.press("p2");
    h.event({ event: "talkbackEnded", producerId: "p1", reason: "listener_left" });
    expect(ended()).toBe(0);
    h.event({ event: "talkbackEnded", producerId: "p2", reason: "speaker_unavailable", message: "The camera's speaker takes AAC." });
    expect(ended()).toBe(1);
    expect(states.at(-1)).toEqual({ state: "ended", reason: "speaker_unavailable", message: "The camera's speaker takes AAC." });
    expect(endedText("expired")).toMatch(/10 minutes/);
    expect(endedText("listener_left")).toMatch(/stopped getting your audio/);
  });
});
