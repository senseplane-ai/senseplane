// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

export interface PlaylistEntry {
  uri: string;
  durationMs: number;
  /** From #EXT-X-PROGRAM-DATE-TIME when present. */
  start?: Date;
}

/** Parses a media playlist into completed segments (a segment is listed only once it is closed). */
export function parsePlaylist(text: string): PlaylistEntry[] {
  const out: PlaylistEntry[] = [];
  let pdt: Date | undefined;
  let dur: number | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) pdt = new Date(line.slice(25));
    else if (line.startsWith("#EXTINF:")) dur = Math.round(Number.parseFloat(line.slice(8)) * 1000);
    else if (line && !line.startsWith("#") && dur !== undefined) {
      out.push({ uri: line, durationMs: dur, start: pdt });
      pdt = undefined;
      dur = undefined;
    }
  }
  return out;
}
