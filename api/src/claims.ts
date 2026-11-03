// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Holding a claimed story or follow (ADR 0058, 0070). The claim functions
// hand out a lease and a token; while the work runs the lease is renewed, and
// the work is stopped when the claim is lost (another process took it over
// after the lease ran out) or when its deadline passes, which is shorter than
// the lease. Only the holder of the current token may write the outcome or
// delete what the attempt made.
import { sql } from "kysely";
import type { DataAccess } from "./data/access.js";

export const MAX_ATTEMPTS = 3;
export const LEASE_S = 900;
/** A job stops after this, well inside its lease. */
export const DEADLINE_MS = 12 * 60_000;
const RENEW_MS = 60_000;

export interface Claimed {
  id: string;
  account_id: string;
  token: string;
}

/** Claims due jobs of a table (`claim_stories` or `claim_follows`). */
export async function claim(data: DataAccess, table: "stories" | "follows", max: number, leaseS = LEASE_S): Promise<Claimed[]> {
  const fn = table === "stories" ? sql.raw("claim_stories") : sql.raw("claim_follows");
  return (await sql<Claimed>`select * from ${fn}(${max}, ${leaseS}, ${MAX_ATTEMPTS})`.execute(data.db())).rows;
}

export interface Hold {
  /** Aborts when the claim is lost or the deadline passes. */
  signal: AbortSignal;
  /** Stops renewing. */
  release(): void;
}

/** Renews a claim's lease every minute while held; aborts when the token is no longer the job's or the deadline passes. */
export function hold(data: DataAccess, table: "stories" | "follows", c: Claimed, o: { renewMs?: number; deadlineMs?: number; leaseS?: number } = {}): Hold {
  const ctrl = new AbortController();
  const lease = o.leaseS ?? LEASE_S;
  const renew = setInterval(() => {
    void data.withAccount(c.account_id, (s) => s.db.updateTable(table)
      .set({ claimed_until: sql<Date>`now() + make_interval(secs => ${lease})` })
      .where("id", "=", c.id).where("claim_token", "=", c.token).executeTakeFirst())
      .then((r) => { if (!Number(r.numUpdatedRows)) ctrl.abort(new Error("claim lost")); })
      .catch(() => undefined);
  }, o.renewMs ?? RENEW_MS);
  renew.unref();
  const deadline = setTimeout(() => ctrl.abort(new Error("deadline")), o.deadlineMs ?? DEADLINE_MS);
  deadline.unref();
  return {
    signal: ctrl.signal,
    release() {
      clearInterval(renew);
      clearTimeout(deadline);
    },
  };
}
