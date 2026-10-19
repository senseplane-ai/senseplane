// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Monthly sensor reading partitions are cut in UTC, whatever time zone the
// session calling ensure_readings_partition is in.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER FUNCTION ensure_readings_partition(timestamptz) SET timezone = 'UTC'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER FUNCTION ensure_readings_partition(timestamptz) RESET timezone`.execute(db);
}
