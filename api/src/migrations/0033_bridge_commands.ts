// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Work for a bridge (ADR 0062): the box long-polls for it outbound, does it
// and reports back. First kind: commission a Matter device with the pairing
// code a person entered (shared from its own app). The code is sealed and
// cleared once the box has taken it.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("bridge_commands")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("bridge_id", "text", (c) => c.notNull().references("bridges.id").onDelete("cascade"))
    .addColumn("kind", "text", (c) => c.notNull())
    // Arguments, encrypted (SECRETS_ENCRYPTION_KEY): a pairing code is a secret for as long as it works.
    .addColumn("args_sealed", "text")
    .addColumn("status", "text", (c) => c.notNull().defaultTo("pending").check(sql`status IN ('pending', 'taken', 'done', 'failed')`))
    .addColumn("result", "jsonb")
    .addColumn("error", "text")
    .addColumn("created_by", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("taken_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .execute();
  await db.schema.createIndex("bridge_commands_waiting").on("bridge_commands").columns(["bridge_id", "status", "created_at"]).execute();
  await sql`ALTER TABLE bridge_commands ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE bridge_commands FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON bridge_commands
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON bridge_commands TO senseplane_app;
    END IF;
  END $$`.execute(db);

  // A box that runs a Matter controller says so (and how many devices it has); null: it has none.
  await db.schema.alterTable("bridges").addColumn("matter_connected", "boolean").addColumn("matter_nodes", "integer").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("bridges").dropColumn("matter_connected").dropColumn("matter_nodes").execute();
  await db.schema.dropTable("bridge_commands").execute();
}
