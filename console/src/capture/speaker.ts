// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The phone's speaker (talk-back, ADR 0069). Two things come out of it: a
// person's push-to-talk (a `talkback` track the page consumes) and an
// agent's or a watch's message (a `speak` event with a clip to fetch, which
// already starts with the chime). One at a time, and a person always wins:
// talking cuts a message off, and a message that arrives while someone talks
// isn't played. A message that can't start within 10 s of arriving is
// dropped rather than played late. While anything plays, the page says so.

/** Something that plays sound: an <audio> element in the page, a fake in tests. */
export interface Sound {
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
}

export type Speaking = "person" | "agent" | null;

/** How long a message may wait to start playing before it's dropped. */
export const START_WITHIN_MS = 10_000;

export class PhoneSpeaker {
  private clip?: { id: string; sound: Sound };
  private readonly talking = new Map<string, Sound>();
  /** True once the browser refused to play without a tap; the page shows a button. */
  blocked = false;

  constructor(private readonly o: {
    /** The API the page got its token from: a clip's path is resolved against it. */
    apiUrl: string;
    /** A sound for a clip's URL. */
    clipSound(url: string): Sound;
    /** Tells the page what is coming out of the speaker now. */
    onChange(speaking: Speaking): void;
    /** The browser wants a tap before the page may play sound. */
    onBlocked?(): void;
    now?: () => number;
  }) {}

  get speaking(): Speaking {
    return this.talking.size ? "person" : this.clip ? "agent" : null;
  }

  private changed() {
    this.o.onChange(this.speaking);
  }

  private stopClip() {
    if (!this.clip) return;
    this.clip.sound.onended = null;
    this.clip.sound.pause();
    this.clip = undefined;
  }

  /** A person started talking (a talkback track is playing): any message stops. */
  personStarted(producerId: string, sound: Sound) {
    this.stopClip();
    this.talking.set(producerId, sound);
    this.changed();
    void sound.play().catch((err) => this.refused(err));
  }

  personStopped(producerId: string) {
    const s = this.talking.get(producerId);
    if (!s) return;
    s.pause();
    this.talking.delete(producerId);
    this.changed();
  }

  /** The `speak` and `speakStop` events (spec/media/signalling.md). Returns whether it handled the event. */
  onEvent(e: { event: string; [k: string]: unknown }): boolean {
    if (e.event === "speakStop") {
      if (this.clip && this.clip.id === e.id) {
        this.stopClip();
        this.changed();
      }
      return true;
    }
    if (e.event !== "speak") return false;
    const id = String(e.id ?? "");
    const url = String(e.url ?? "");
    if (!id || !url) return true;
    // A person is talking: they win, and the message isn't saved for later.
    if (this.talking.size) return true;
    const now = this.o.now ?? Date.now;
    const arrived = now();
    this.stopClip();
    const sound = this.o.clipSound(this.resolve(url));
    const clip = { id, sound };
    this.clip = clip;
    sound.onended = () => {
      if (this.clip === clip) {
        this.clip = undefined;
        this.changed();
      }
    };
    this.changed();
    void sound.play().then(() => {
      // Started too late (a slow network): never play an old message.
      if (now() - arrived > START_WITHIN_MS && this.clip === clip) {
        this.stopClip();
        this.changed();
      }
    }, (err) => {
      if (this.clip === clip) {
        this.clip = undefined;
        this.changed();
      }
      this.refused(err);
    });
    return true;
  }

  /** Everything stops (the page paused or stopped). */
  stopAll() {
    this.stopClip();
    for (const s of this.talking.values()) s.pause();
    this.talking.clear();
    this.changed();
  }

  private refused(err: unknown) {
    if ((err as { name?: string })?.name === "NotAllowedError") {
      this.blocked = true;
      this.o.onBlocked?.();
    }
  }

  private resolve(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    return `${this.o.apiUrl.replace(/\/$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
  }
}

/** What the page says while something plays. */
export const speakingText = (s: Speaking) =>
  s === "person" ? "Someone is speaking through this phone" : s === "agent" ? "An automated message is playing on this phone" : "";
