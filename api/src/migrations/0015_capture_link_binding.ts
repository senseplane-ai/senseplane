// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Capture links are bound to the first device that joins, and rotating the
  // link bumps the epoch so earlier links stop working (ADR 0038).
  await db.schema
    .alterTable("sources")
    .addColumn("capture_epoch", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("capture_device_hash", "text")
    .addColumn("capture_bound_at", "timestamptz")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sources").dropColumn("capture_epoch").dropColumn("capture_device_hash").dropColumn("capture_bound_at").execute();
}
