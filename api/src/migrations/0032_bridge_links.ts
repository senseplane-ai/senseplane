// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// When a box could read Home Assistant (ADR 0061): spans built from its
// health reports, so a question about its sensors knows which stretches it
// couldn't see, as recorded ranges do for cameras. Kept as long as readings.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("bridge_links")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("bridge_id", "text", (c) => c.notNull().references("bridges.id").onDelete("cascade"))
    .addColumn("started_at", "timestamptz", (c) => c.notNull())
    .addColumn("ended_at", "timestamptz", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("bridge_links_bridge_time").on("bridge_links").columns(["bridge_id", "ended_at"]).execute();
  await sql`ALTER TABLE bridge_links ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE bridge_links FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON bridge_links
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON bridge_links TO senseplane_app;
      GRANT USAGE ON SEQUENCE bridge_links_id_seq TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("bridge_links").execute();
}
