// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Push-to-talk (ADR 0069), the button's state machine. The microphone is on
// only while the button is held: a press asks for it and produces a track;
// a release closes the track and stops the microphone, so the browser's mic
// indicator goes off. A release that comes while the press is still waiting
// (the permission prompt, connecting, producing) wins: whatever that press
// makes afterwards is closed at once. One press at a time: a second press
// while one is held, or a new press while a release is finishing, never
// leaves a second track behind.
import type { TalkState } from "./heard";

export interface TalkTrack {
  readonly id: string;
  close(): void;
}

export interface TalkDeps {
  /** Asks for the microphone (the browser may show a prompt). */
  microphone(): Promise<MediaStream>;
  /** Sends the track to the camera; resolves once the media plane has it. */
  produce(track: MediaStreamTrack): Promise<TalkTrack>;
  /** Tells the media plane the track is gone. */
  closed(id: string): Promise<void>;
  /** The live view closed: nothing more may start. */
  ended(): boolean;
}

export interface Talk {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly active: boolean;
  /** What the camera says about the press held now: connecting, heard, or ended by the camera's side (ADR 0074). */
  onState?(fn: (s: TalkState) => void): () => void;
  /** It waits for the camera's word before saying "Talking" (an IP camera behind a box). */
  readonly confirms?: boolean;
}

export function createTalk(d: TalkDeps): Talk & { /** The microphone is open (tests). */ readonly micOpen: boolean } {
  let wanted = false;
  /** Moves on every release: a press that started before it gives up. */
  let gen = 0;
  let mic: MediaStream | undefined;
  let track: TalkTrack | undefined;
  let pending: { gen: number; done: Promise<void> } | undefined;
  /** A release still closing things: a new press waits for it. */
  let stopping: Promise<void> | undefined;

  const stopMic = () => {
    for (const t of mic?.getTracks() ?? []) t.stop();
    mic = undefined;
  };
  const drop = async (t: TalkTrack) => {
    t.close();
    await d.closed(t.id).catch(() => undefined);
  };

  const press = async (my: number) => {
    const live = () => wanted && my === gen && !d.ended();
    const m = await d.microphone();
    mic = m;
    if (!live()) return stopMic();
    const audio = m.getAudioTracks()[0];
    if (!audio) {
      stopMic();
      throw Object.assign(new Error("No microphone was found."), { code: "no_microphone" });
    }
    let t: TalkTrack;
    try {
      t = await d.produce(audio);
    } catch (err) {
      stopMic();
      throw err;
    }
    if (!live()) {
      // Released while it was being set up: never let it stream.
      stopMic();
      return drop(t);
    }
    track = t;
  };

  return {
    get active() {
      return !!track;
    },
    get micOpen() {
      return !!mic;
    },
    start() {
      if (d.ended()) return Promise.resolve();
      wanted = true;
      if (track && !stopping) return Promise.resolve();
      if (pending && pending.gen === gen) return pending.done; // held already: the same press
      const my = gen;
      const before = stopping ?? pending?.done;
      const done = (async () => {
        await before?.catch(() => undefined); // a release still finishing goes first
        if (wanted && my === gen) await press(my);
      })().finally(() => {
        if (pending?.done === done) pending = undefined;
      });
      pending = { gen: my, done };
      return done;
    },
    stop() {
      wanted = false;
      gen++;
      const prior = stopping;
      const held = pending?.done; // the press this releases, not one made after it
      const run: Promise<void> = (async () => {
        await prior;
        await held?.catch(() => undefined);
        const t = track;
        track = undefined;
        if (t) await drop(t);
        stopMic();
      })().finally(() => {
        if (stopping === run) stopping = undefined;
      });
      stopping = run;
      return run;
    },
  };
}
