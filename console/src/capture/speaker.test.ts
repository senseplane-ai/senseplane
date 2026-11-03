// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { reactTo } from "./events";
import { PhoneSpeaker, type Sound, type Speaking, START_WITHIN_MS, speakingText } from "./speaker";

class FakeSound implements Sound {
  playing = false;
  onended: (() => void) | null = null;
  constructor(readonly url = "", private readonly start: () => Promise<void> = async () => undefined) {}
  async play() {
    await this.start();
    this.playing = true;
  }
  pause() {
    this.playing = false;
  }
  end() {
    this.playing = false;
    this.onended?.();
  }
}

function setup(o: { now?: () => number; start?: () => Promise<void> } = {}) {
  const sounds: FakeSound[] = [];
  const states: Speaking[] = [];
  let blocked = 0;
  const speaker = new PhoneSpeaker({
    apiUrl: "https://api.example.test/",
    clipSound: (url) => {
      const s = new FakeSound(url, o.start);
      sounds.push(s);
      return s;
    },
    onChange: (s) => states.push(s),
    onBlocked: () => blocked++,
    ...(o.now ? { now: o.now } : {}),
  });
  return { speaker, sounds, states, blocked: () => blocked };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the phone's speaker", () => {
  it("plays an agent's clip from the API it got its token from, and says so while it plays", async () => {
    const { speaker, sounds, states } = setup();
    expect(speaker.onEvent({ event: "speak", id: "spk_1", url: "/media/tok/speak.wav", durationMs: 2400 })).toBe(true);
    await tick();
    expect(sounds[0]).toMatchObject({ url: "https://api.example.test/media/tok/speak.wav", playing: true });
    expect(speaker.speaking).toBe("agent");
    expect(speakingText("agent")).toMatch(/automated message/);
    sounds[0]!.end();
    expect(states).toEqual(["agent", null]);
  });

  it("lets a person's push-to-talk cut a message off, and doesn't play one while they talk", async () => {
    const { speaker, sounds, states } = setup();
    speaker.onEvent({ event: "speak", id: "spk_1", url: "/media/a/speak.wav", durationMs: 5000 });
    await tick();
    const voice = new FakeSound();
    speaker.personStarted("p-talk", voice);
    await tick();
    expect(sounds[0]!.playing).toBe(false);
    expect(voice.playing).toBe(true);
    expect(speaker.speaking).toBe("person");
    expect(speakingText("person")).toBe("Someone is speaking through this phone");
    speaker.onEvent({ event: "speak", id: "spk_2", url: "/media/b/speak.wav", durationMs: 1000 });
    expect(sounds).toHaveLength(1); // never queued for later
    speaker.personStopped("p-talk");
    expect(states).toEqual(["agent", "person", null]);
  });

  it("stops a clip when told, and drops one that can't start within 10 s", async () => {
    const { speaker, sounds } = setup();
    speaker.onEvent({ event: "speak", id: "spk_1", url: "https://api.example.test/media/a/speak.wav", durationMs: 5000 });
    await tick();
    speaker.onEvent({ event: "speakStop", id: "other" });
    expect(sounds[0]!.playing).toBe(true);
    speaker.onEvent({ event: "speakStop", id: "spk_1" });
    expect(sounds[0]!.playing).toBe(false);
    expect(speaker.speaking).toBe(null);

    let t = 0;
    const late = setup({ now: () => t, start: async () => { t += START_WITHIN_MS + 1; } });
    late.speaker.onEvent({ event: "speak", id: "spk_3", url: "/media/c/speak.wav", durationMs: 1000 });
    await tick();
    await tick();
    expect(late.sounds[0]!.playing).toBe(false);
    expect(late.speaker.speaking).toBe(null);
  });

  it("asks for a tap when the browser won't play sound yet", async () => {
    const { speaker, blocked } = setup({ start: async () => { throw Object.assign(new Error("no"), { name: "NotAllowedError" }); } });
    speaker.onEvent({ event: "speak", id: "spk_1", url: "/media/a/speak.wav", durationMs: 1000 });
    await tick();
    await tick();
    expect(blocked()).toBe(1);
    expect(speaker.blocked).toBe(true);
    expect(speaker.speaking).toBe(null);
  });

  it("ignores other events, and a consumed track closing isn't the camera stopping", () => {
    expect(setup().speaker.onEvent({ event: "producerAppeared" })).toBe(false);
    expect(reactTo({ event: "producerClosed", producerId: "p", consumerId: "c" })).toEqual({ action: "ignore" });
    expect(reactTo({ event: "producerClosed", producerId: "p" }).action).toBe("notice");
  });
});
