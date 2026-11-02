// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Cameras a box found (ADR 0063): ONVIF cameras on its network, named after
// the Home Assistant camera they match, listed for a person to pick. The box
// replaces the list whenever it changes; it never holds credentials.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("bridge_cameras_found")
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("bridge_id", "text", (c) => c.notNull().references("bridges.id").onDelete("cascade"))
    // The camera's ONVIF endpoint (urn:uuid:…), or the Home Assistant entity for one without ONVIF.
    .addColumn("found_id", "text", (c) => c.notNull())
    .addColumn("address", "text")
    .addColumn("xaddr", "text")
    .addColumn("manufacturer", "text")
    .addColumn("model", "text")
    .addColumn("name", "text")
    .addColumn("onvif", "boolean", (c) => c.notNull())
    .addColumn("ha_entity_id", "text")
    .addColumn("ha_name", "text")
    .addColumn("ha_area", "text")
    .addColumn("seen_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("bridge_cameras_found_pk", ["bridge_id", "found_id"])
    .execute();
  await sql`ALTER TABLE bridge_cameras_found ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE bridge_cameras_found FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON bridge_cameras_found
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON bridge_cameras_found TO senseplane_app;
    END IF;
  END $$`.execute(db);

  // A box that looks for cameras says how many it lists; null: it doesn't look.
  await db.schema.alterTable("bridges").addColumn("cameras_found", "integer").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("bridges").dropColumn("cameras_found").execute();
  await db.schema.dropTable("bridge_cameras_found").execute();
}
