// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// MQTT out (ADR 0071): a box publishes Senseplane's events to its MQTT broker,
// for Home Assistant, only when the account turns it on for that box. A box
// reads the account's events after its cursor (an event id), hence the index.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("bridges").addColumn("mqtt_publish", "boolean", (c) => c.notNull().defaultTo(false)).execute();
  await sql`CREATE INDEX events_account_id_idx ON events (account_id, id)`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX events_account_id_idx`.execute(db);
  await db.schema.alterTable("bridges").dropColumn("mqtt_publish").execute();
}
