// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Reading recordings for stories and object following (ADR 0070). Segments
// are grouped into runs (one recorder session, no break), and a run's bytes
// (its init, then each segment decrypted, ADR 0066) are produced one segment
// at a time, to be piped into ffmpeg: decrypted footage is never written to
// disk, and never held whole in memory.
import type { KeyRing } from "./keys.js";
import { decryptSegment, segmentKey } from "./keys.js";
import { audioTrackIds } from "./fmp4.js";
import type { segmentsIn } from "./routes/playback.js";
import { type ObjectStorage, readObject } from "./storage.js";

export type SegmentRow = Awaited<ReturnType<typeof segmentsIn>>[number];

export interface Run {
  initKey: string;
  init: Buffer;
  rows: SegmentRow[];
  start: number;
  end: number;
  hasAudio: boolean;
}

export interface ReaderDeps {
  storage: ObjectStorage;
  keys: KeyRing;
}

const startOf = (r: SegmentRow) => new Date(r.start_at).getTime();

/** Segments (in time order) as runs: a new recorder session, or a gap over 1.5 s, starts a new one. Reads only the inits. */
export async function runsOf(deps: ReaderDeps, rows: SegmentRow[]): Promise<Run[]> {
  const runs: Run[] = [];
  for (const r of rows) {
    const last = runs.at(-1);
    if (last && last.initKey === r.init_key && startOf(r) - last.end < 1500) {
      last.rows.push(r);
      last.end = startOf(r) + r.duration_ms;
      continue;
    }
    runs.push({ initKey: r.init_key, init: Buffer.alloc(0), rows: [r], start: startOf(r), end: startOf(r) + r.duration_ms, hasAudio: false });
  }
  const inits = new Map<string, Buffer>();
  for (const run of runs) {
    let init = inits.get(run.initKey);
    if (!init) {
      init = await readObject(deps.storage, run.initKey);
      inits.set(run.initKey, init);
    }
    run.init = init;
    try {
      run.hasAudio = audioTrackIds(init).size > 0;
    } catch {
      run.hasAudio = false;
    }
  }
  return runs;
}

/** Decrypts segments of one camera, caching its key per version. */
export function segmentDecrypter(deps: ReaderDeps, accountId: string, sourceId: string) {
  const cache = new Map<number, Buffer>();
  return async (r: Pick<SegmentRow, "enc_version" | "enc_iv">, body: Buffer): Promise<Buffer> => {
    if (r.enc_version === null || !r.enc_iv) return body;
    let k = cache.get(r.enc_version);
    if (!k) {
      const dk = await deps.keys.get(accountId, r.enc_version);
      if (!dk) throw new Error("this recording's key no longer exists");
      k = segmentKey(dk, sourceId);
      cache.set(r.enc_version, k);
    }
    return decryptSegment(k, r.enc_iv, body);
  };
}

/** A run's bytes as one fMP4 stream: the init, then each segment decrypted as it is read (two read ahead). */
export async function* runBytes(deps: ReaderDeps, accountId: string, sourceId: string, run: Run): AsyncGenerator<Buffer> {
  const decrypt = segmentDecrypter(deps, accountId, sourceId);
  yield run.init;
  const read = (r: SegmentRow) => readObject(deps.storage, r.key).then((b) => decrypt(r, b));
  const quiet = (p: Promise<Buffer>) => (p.catch(() => undefined), p); // a reader that stops early leaves no unhandled rejection
  const ahead: Promise<Buffer>[] = run.rows.slice(0, 2).map((r) => quiet(read(r)));
  for (let i = 0; i < run.rows.length; i++) {
    const next = run.rows[i + 2];
    if (next) ahead.push(quiet(read(next)));
    yield await ahead.shift()!;
  }
}
