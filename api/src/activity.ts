// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Activities (ADR 0057): the rows the brain reports (brain-events.ts
// storeActivity), and the sweep that ends the ones whose brain went quiet.
import { sql } from "kysely";
import type { DataAccess } from "./data/access.js";

/** An open activity with no update for this long ends where it was last seen (brain heartbeats are every 60 s). */
export const STALE_ACTIVITY_S = 180;

export async function closeStaleActivities(data: DataAccess): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT close_stale_activities(${STALE_ACTIVITY_S}) AS n`.execute(data.db());
  return Number(rows[0]?.n ?? 0);
}
