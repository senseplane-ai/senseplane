// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// ffmpeg children never outlive their job (ADR 0070): an aborted job, one past
// its timeout, one whose piped input fails half way, and the API closing all
// leave no ffmpeg running, even when another input would never end.
import { afterEach, describe, expect, it } from "vitest";
import { ffmpeg, ffmpegPids, killAllFfmpeg, runningFfmpeg, splitJpegs } from "./ffmpeg.js";

/** An input that never ends: without a kill, this ffmpeg would run for ever. */
const ENDLESS = ["-f", "lavfi", "-i", "testsrc=size=64x64:rate=25", "-f", "null", "-"];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const started = async () => {
  for (let i = 0; i < 100 && !ffmpegPids().length; i++) await new Promise((r) => setTimeout(r, 20));
  const pids = ffmpegPids();
  expect(pids.length).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 200)); // it is running
  return pids;
};
const gone = async (pids: number[]) => {
  expect(runningFfmpeg()).toBe(0);
  for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 20));
  expect(pids.filter(alive)).toEqual([]);
};

describe("ffmpeg children", () => {
  afterEach(() => expect(runningFfmpeg()).toBe(0));

  it("kills ffmpeg when its job is aborted", async () => {
    const ctrl = new AbortController();
    const run = ffmpeg(ENDLESS, { signal: ctrl.signal, timeoutMs: 60_000 });
    const pids = await started();
    ctrl.abort();
    await expect(run).rejects.toThrow(/stopped/);
    await gone(pids);
  });

  it("kills ffmpeg past its timeout", async () => {
    const run = ffmpeg(ENDLESS, { timeoutMs: 500 });
    await expect(run).rejects.toThrow(/timed out/);
    expect(runningFfmpeg()).toBe(0);
  });

  it("kills ffmpeg when its piped input fails half way, even with another endless input", async () => {
    async function* broken() {
      yield Buffer.alloc(1000);
      await new Promise((r) => setTimeout(r, 300));
      throw new Error("the recording could not be read");
    }
    const run = ffmpeg(["-f", "mp4", "-i", "pipe:0", ...ENDLESS], { input: broken(), timeoutMs: 60_000 });
    const pids = await started();
    await expect(run).rejects.toThrow();
    await gone(pids);
  });

  it("kills every ffmpeg when the API closes", async () => {
    const runs = [ffmpeg(ENDLESS, { timeoutMs: 60_000 }), ffmpeg(ENDLESS, { timeoutMs: 60_000 })];
    for (let i = 0; i < 100 && ffmpegPids().length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    const pids = ffmpegPids();
    killAllFfmpeg();
    for (const r of runs) await expect(r).rejects.toThrow();
    await gone(pids);
  });

  it("splits a JPEG stream", () => {
    const j = (n: number) => Buffer.from([0xff, 0xd8, n, n, 0xff, 0xd9]);
    expect(splitJpegs(Buffer.concat([j(1), j(2)])).map((b) => b[2])).toEqual([1, 2]);
  });
});
