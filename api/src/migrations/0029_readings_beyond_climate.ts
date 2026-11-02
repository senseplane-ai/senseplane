// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Readings beyond climate (ADR 0060): a kind (number, state, event), the device
// that measured it when a source has several, and an event's detail. States are
// stored as 1/0 and events as 1, so `value` stays a number. Adding the columns
// to the partitioned table adds them to every partition.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sensor_readings
    ADD COLUMN kind text NOT NULL DEFAULT 'number' CHECK (kind IN ('number', 'state', 'event')),
    ADD COLUMN device_id text,
    ADD COLUMN device_name text,
    ADD COLUMN detail text`.execute(db);
  await sql`CREATE INDEX sensor_readings_source_sense_time ON sensor_readings (source_id, sense, measured_at)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS sensor_readings_source_sense_time`.execute(db);
  await sql`ALTER TABLE sensor_readings DROP COLUMN kind, DROP COLUMN device_id, DROP COLUMN device_name, DROP COLUMN detail`.execute(db);
}
