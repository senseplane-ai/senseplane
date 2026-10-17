// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Track selection for fragmented MP4 (CMAF) without re-encoding (ADR 0037).
//
// Recordings keep video and audio in the same fMP4 segments. An agent with a
// video grant but no audio grant must not receive the audio, so playback for
// such scopes removes the audio track: the `trak`/`trex` boxes from the init
// segment, and the audio `traf` boxes plus their sample bytes from each media
// segment (the `mdat` is rebuilt from the remaining samples and every
// `trun` data offset is rewritten). Only box bookkeeping changes; samples are
// copied byte for byte.

interface Box {
  type: string;
  start: number; // offset of the box header in the parent buffer
  headerSize: number;
  size: number;
}

function readBoxes(buf: Buffer, from = 0, to = buf.length): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    let headerSize = 8;
    if (size === 1) {
      if (p + 16 > to) throw new Fmp4Error("truncated box");
      const big = buf.readBigUInt64BE(p + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Fmp4Error("box too large");
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < headerSize || p + size > to) throw new Fmp4Error(`bad box ${type}`);
    out.push({ type, start: p, headerSize, size });
    p += size;
  }
  return out;
}

export class Fmp4Error extends Error {}

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

const payload = (buf: Buffer, b: Box) => buf.subarray(b.start + b.headerSize, b.start + b.size);
const whole = (buf: Buffer, b: Box) => buf.subarray(b.start, b.start + b.size);

/** Track IDs whose handler is audio ('soun'), from an init segment's moov. */
export function audioTrackIds(init: Buffer): Set<number> {
  const ids = new Set<number>();
  const moov = readBoxes(init).find((b) => b.type === "moov");
  if (!moov) return ids;
  const m = payload(init, moov);
  for (const trak of readBoxes(m).filter((b) => b.type === "trak")) {
    const t = payload(m, trak);
    const tkhd = readBoxes(t).find((b) => b.type === "tkhd");
    const mdia = readBoxes(t).find((b) => b.type === "mdia");
    if (!tkhd || !mdia) continue;
    const tk = payload(t, tkhd);
    const trackId = tk.readUInt32BE(tk[0] === 1 ? 20 : 12);
    const md = payload(t, mdia);
    const hdlr = readBoxes(md).find((b) => b.type === "hdlr");
    if (hdlr && payload(md, hdlr).toString("latin1", 8, 12) === "soun") ids.add(trackId);
  }
  return ids;
}

/** Init segment without audio tracks (trak and trex removed). */
export function stripAudioInit(init: Buffer): Buffer {
  const audio = audioTrackIds(init);
  if (!audio.size) return init;
  const parts: Buffer[] = [];
  for (const top of readBoxes(init)) {
    if (top.type !== "moov") {
      parts.push(whole(init, top));
      continue;
    }
    const m = payload(init, top);
    const children: Buffer[] = [];
    for (const c of readBoxes(m)) {
      if (c.type === "trak") {
        const t = payload(m, c);
        const tkhd = readBoxes(t).find((b) => b.type === "tkhd")!;
        const tk = payload(t, tkhd);
        if (audio.has(tk.readUInt32BE(tk[0] === 1 ? 20 : 12))) continue;
        children.push(whole(m, c));
      } else if (c.type === "mvex") {
        const mv = payload(m, c);
        const kept = readBoxes(mv).filter((b) => !(b.type === "trex" && audio.has(payload(mv, b).readUInt32BE(4))));
        children.push(box("mvex", ...kept.map((b) => whole(mv, b))));
      } else {
        children.push(whole(m, c));
      }
    }
    parts.push(box("moov", ...children));
  }
  return Buffer.concat(parts);
}

interface Run {
  trunPos: number; // offset of the trun payload within the traf payload
  hasOffset: boolean;
  dataStart: number; // absolute offset of the run's first byte in the segment
  bytes: number;
}

/** Parses one traf: track id, sample runs and where their bytes live. */
function parseTraf(seg: Buffer, traf: Buffer, moofStart: number) {
  const boxes = readBoxes(traf);
  const tfhdBox = boxes.find((b) => b.type === "tfhd");
  if (!tfhdBox) throw new Fmp4Error("traf without tfhd");
  const tf = payload(traf, tfhdBox);
  const tfFlags = tf.readUInt32BE(0) & 0xffffff;
  const trackId = tf.readUInt32BE(4);
  let p = 8;
  let base = moofStart;
  if (tfFlags & 0x000001) {
    base = Number(tf.readBigUInt64BE(p));
    p += 8;
  }
  if (tfFlags & 0x000002) p += 4; // sample_description_index
  if (tfFlags & 0x000008) p += 4; // default_sample_duration
  const defaultSize = tfFlags & 0x000010 ? tf.readUInt32BE(p) : undefined;
  const runs: Run[] = [];
  let next = base;
  for (const b of boxes.filter((x) => x.type === "trun")) {
    const tr = payload(traf, b);
    const flags = tr.readUInt32BE(0) & 0xffffff;
    const count = tr.readUInt32BE(4);
    let q = 8;
    let start = next;
    const hasOffset = Boolean(flags & 0x000001);
    if (hasOffset) {
      start = base + tr.readInt32BE(q);
      q += 4;
    }
    if (flags & 0x000004) q += 4;
    let bytes = 0;
    for (let i = 0; i < count; i++) {
      if (flags & 0x000100) q += 4;
      if (flags & 0x000200) {
        bytes += tr.readUInt32BE(q);
        q += 4;
      } else if (defaultSize !== undefined) {
        bytes += defaultSize;
      } else {
        throw new Fmp4Error("sample sizes unknown");
      }
      if (flags & 0x000400) q += 4;
      if (flags & 0x000800) q += 4;
    }
    if (start < 0 || start + bytes > seg.length) throw new Fmp4Error("sample data out of range");
    runs.push({ trunPos: b.start + b.headerSize, hasOffset, dataStart: start, bytes });
    next = start + bytes;
  }
  return { trackId, tfhdBox, tfFlags, runs };
}

/**
 * A media segment (one or more moof+mdat pairs) without the given tracks.
 * Every fragment is rewritten to default-base-is-moof with explicit data offsets.
 */
export function stripTracksFromSegment(seg: Buffer, drop: Set<number>): Buffer {
  if (!drop.size) return seg;
  const top = readBoxes(seg);
  const out: Buffer[] = [];
  for (let i = 0; i < top.length; i++) {
    const b = top[i]!;
    if (b.type === "sidx") continue; // byte ranges would be stale; HLS players don't need it
    if (b.type === "mdat") continue; // rebuilt with its moof
    if (b.type !== "moof") {
      out.push(whole(seg, b));
      continue;
    }
    const moof = payload(seg, b);
    const kept: { traf: Buffer; parsed: ReturnType<typeof parseTraf> }[] = [];
    let mfhd: Buffer | undefined;
    for (const c of readBoxes(moof)) {
      if (c.type === "mfhd") mfhd = whole(moof, c);
      if (c.type !== "traf") continue;
      const traf = payload(moof, c);
      const parsed = parseTraf(seg, traf, b.start);
      if (!drop.has(parsed.trackId)) kept.push({ traf: Buffer.from(traf), parsed });
    }
    if (!mfhd) throw new Fmp4Error("moof without mfhd");
    // Rewrite tfhd (default-base-is-moof, no base_data_offset) and give every trun an explicit offset.
    const rebuilt: { traf: Buffer; runs: { bytesFrom: number; bytes: number }[]; offsetFieldPos: number[] }[] = [];
    for (const k of kept) {
      const boxes = readBoxes(k.traf);
      const children: Buffer[] = [];
      const offsetFieldPos: number[] = [];
      let pos = 8; // traf header
      for (const c of boxes) {
        let body = payload(k.traf, c);
        if (c.type === "tfhd") {
          const flags = body.readUInt32BE(0) & 0xffffff;
          if (flags & 0x000001) body = Buffer.concat([body.subarray(0, 8), body.subarray(16)]);
          const out = Buffer.from(body);
          out.writeUInt32BE(((out[0]! << 24) | ((flags & ~0x000001) | 0x020000)) >>> 0, 0);
          body = out;
        } else if (c.type === "trun") {
          const flags = body.readUInt32BE(0) & 0xffffff;
          if (!(flags & 0x000001)) {
            body = Buffer.concat([body.subarray(0, 8), Buffer.alloc(4), body.subarray(8)]);
            body.writeUInt32BE(((body[0]! << 24) | (flags | 0x000001)) >>> 0, 0);
          } else {
            body = Buffer.from(body);
          }
          offsetFieldPos.push(pos + 8 + 8); // header + version/flags + sample_count
        }
        const child = box(c.type, body);
        children.push(child);
        pos += child.length;
      }
      rebuilt.push({ traf: box("traf", ...children), runs: k.parsed.runs.map((r) => ({ bytesFrom: r.dataStart, bytes: r.bytes })), offsetFieldPos });
    }
    const newMoofSize = 8 + mfhd.length + rebuilt.reduce((n, r) => n + r.traf.length, 0);
    const mdatParts: Buffer[] = [];
    let cursor = newMoofSize + 8; // first sample byte, relative to the moof start
    for (const r of rebuilt) {
      r.runs.forEach((run, idx) => {
        r.traf.writeInt32BE(cursor, r.offsetFieldPos[idx]!);
        mdatParts.push(seg.subarray(run.bytesFrom, run.bytesFrom + run.bytes));
        cursor += run.bytes;
      });
    }
    out.push(box("moof", mfhd, ...rebuilt.map((r) => r.traf)), box("mdat", ...mdatParts));
  }
  return Buffer.concat(out);
}
