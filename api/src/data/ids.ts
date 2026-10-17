// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID (26 chars, time-sortable) for public IDs. */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(16);
  let r = "";
  for (let i = 0; i < 16; i++) r += CROCKFORD[rand[i]! % 32];
  return time + r;
}

export type IdPrefix = "usr" | "src" | "wat" | "evt" | "clp" | "agt" | "grt" | "whk" | "key" | "dlv" | "inv" | "cnv" | "msg" | "inb";
export const newId = (prefix: IdPrefix) => `${prefix}_${ulid()}`;
