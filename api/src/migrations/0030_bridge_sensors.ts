// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// A bridge reads Home Assistant (ADR 0061): it lists the entities it can send
// (`bridge_entities`) and a person chooses which; a chosen entity's readings
// go to the sensor source of its room (`source_id`, one per bridge and room).
// Bridges also say whether Home Assistant is connected.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("bridge_entities")
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("bridge_id", "text", (c) => c.notNull().references("bridges.id").onDelete("cascade"))
    .addColumn("entity_id", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("area", "text")
    .addColumn("device_class", "text")
    .addColumn("sense", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    // Set when a person chose it: where its readings go.
    .addColumn("source_id", "text", (c) => c.references("sources.id").onDelete("set null"))
    // False when Home Assistant no longer lists it.
    .addColumn("listed", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("bridge_entities_pk", ["bridge_id", "entity_id"])
    .execute();
  await sql`ALTER TABLE bridge_entities ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE bridge_entities FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON bridge_entities
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON bridge_entities TO senseplane_app;
    END IF;
  END $$`.execute(db);

  await db.schema
    .alterTable("bridges")
    .addColumn("home_connected", "boolean")
    .addColumn("home_entities", "integer")
    .addColumn("home_sending", "integer")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("bridges").dropColumn("home_connected").dropColumn("home_entities").dropColumn("home_sending").execute();
  await db.schema.dropTable("bridge_entities").execute();
}
