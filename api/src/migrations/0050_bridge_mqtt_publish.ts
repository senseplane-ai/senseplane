// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// MQTT out (ADR 0071): a box publishes Senseplane's events to its MQTT broker,
// for Home Assistant, only when the account turns it on for that box.
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("bridges").addColumn("mqtt_publish", "boolean", (c) => c.notNull().defaultTo(false)).execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("bridges").dropColumn("mqtt_publish").execute();
}
