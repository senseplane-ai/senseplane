// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // watch.triggered: true when a vision model confirmed it, false when the check was skipped (no model); null otherwise (ADR 0028).
  await db.schema.alterTable("events").addColumn("verified", "boolean").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("events").dropColumn("verified").execute();
}
