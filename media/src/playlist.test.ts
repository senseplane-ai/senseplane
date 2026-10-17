// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { parsePlaylist } from "./playlist.js";

it("lists only closed segments with their program date time", () => {
  const text = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-10-15T21:00:00.000+0000
#EXTINF:6.000000,
seg_000000.m4s
#EXT-X-PROGRAM-DATE-TIME:2026-10-15T21:00:06.000+0000
#EXTINF:6.500000,
seg_000001.m4s
`;
  const entries = parsePlaylist(text);
  expect(entries.map((e) => [e.uri, e.durationMs, e.start?.toISOString()])).toEqual([
    ["seg_000000.m4s", 6000, "2026-10-15T21:00:00.000Z"],
    ["seg_000001.m4s", 6500, "2026-10-15T21:00:06.000Z"],
  ]);
});
