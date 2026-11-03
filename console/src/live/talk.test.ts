// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// Push-to-talk never leaves the microphone on after the button is released (ADR 0069).
import { describe, expect, it } from "vitest";
import { createTalk } from "./talk";

const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(o: { slowMic?: boolean; slowProduce?: boolean } = {}) {
  const log: string[] = [];
  const open = new Set<string>();
  let micStops = 0;
  let n = 0;
  const mics: { resolve(): void }[] = [];
  const produces: { resolve(): void }[] = [];
  const stream = () => {
    const track = { kind: "audio", stop: () => { micStops++; log.push("mic off"); } } as unknown as MediaStreamTrack;
    return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  };
  const talk = createTalk({
    microphone: async () => {
      log.push("mic asked");
      if (o.slowMic) {
        const d = deferred<void>();
        mics.push({ resolve: () => d.resolve() });
        await d.promise;
      }
      return stream();
    },
    produce: async () => {
      if (o.slowProduce) {
        const d = deferred<void>();
        produces.push({ resolve: () => d.resolve() });
        await d.promise;
      }
      const id = `p${++n}`;
      open.add(id);
      log.push(`produced ${id}`);
      return { id, close: () => open.delete(id) };
    },
    closed: async (id) => void log.push(`closed ${id}`),
    ended: () => false,
  });
  return { talk, log, open, mics, produces, stops: () => micStops };
}

describe("push-to-talk", () => {
  it("talks while held, and turns the microphone off on release", async () => {
    const s = setup();
    await s.talk.start();
    expect(s.talk.active).toBe(true);
    expect([...s.open]).toEqual(["p1"]);
    await s.talk.stop();
    expect(s.talk.active).toBe(false);
    expect(s.open.size).toBe(0);
    expect(s.talk.micOpen).toBe(false);
    expect(s.log).toEqual(["mic asked", "produced p1", "closed p1", "mic off"]);
  });

  it("never streams when the button is released during the permission prompt", async () => {
    const s = setup({ slowMic: true });
    const started = s.talk.start();
    await tick();
    const stopped = s.talk.stop(); // released while the browser asks
    s.mics[0]!.resolve(); // then the person allows the microphone
    await started;
    await stopped;
    expect(s.open.size).toBe(0);
    expect(s.log).not.toContain("produced p1");
    expect(s.talk.micOpen).toBe(false);
    expect(s.stops()).toBe(1);
  });

  it("closes a track that was still being made when a quick tap ended", async () => {
    const s = setup({ slowProduce: true });
    const started = s.talk.start();
    await tick();
    await tick();
    const stopped = s.talk.stop();
    s.produces[0]!.resolve();
    await started;
    await stopped;
    expect(s.open.size).toBe(0);
    expect(s.log).toContain("closed p1");
    expect(s.talk.active).toBe(false);
    expect(s.talk.micOpen).toBe(false);
  });

  it("makes one track for a double press, and a press after a release starts afresh", async () => {
    const s = setup({ slowProduce: true });
    const a = s.talk.start();
    const b = s.talk.start(); // a second press while the first is still connecting
    await tick();
    await tick();
    s.produces[0]!.resolve();
    await Promise.all([a, b]);
    expect([...s.open]).toEqual(["p1"]);
    expect(s.log.filter((l) => l === "mic asked")).toHaveLength(1);

    const stopped = s.talk.stop();
    const again = s.talk.start(); // pressed again before the release finished
    await stopped;
    await tick();
    await tick();
    s.produces[1]?.resolve();
    await again;
    expect([...s.open]).toEqual(["p2"]);
    await s.talk.stop();
    expect(s.open.size).toBe(0);
    expect(s.talk.micOpen).toBe(false);
  });
});
