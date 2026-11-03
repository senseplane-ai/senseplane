// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// A grant can be "blurred only" (ADR 0068): its agent gets blurred snapshots,
// looks and answers for those sources, and no raw playback, clips or live view.
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("grants").addColumn("blurred_only", "boolean", (c) => c.notNull().defaultTo(false)).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("grants").dropColumn("blurred_only").execute();
}
