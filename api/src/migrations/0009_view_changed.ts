// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Set by the brain's source.view_changed event; cleared when masks are saved (ADR 0024).
  await db.schema.alterTable("sources").addColumn("view_changed_at", "timestamptz").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sources").dropColumn("view_changed_at").execute();
}
