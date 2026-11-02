// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Footage encrypted at rest (ADR 0066): each account's data keys, wrapped by
// the instance's MEDIA_ENCRYPTION_KEY (never stored here), and per segment the
// key version and IV it was encrypted with (null: stored in clear, from before).
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("account_keys")
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("version", "integer", (c) => c.notNull())
    .addColumn("wrapped", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("account_keys_pk", ["account_id", "version"])
    .execute();
  await sql`ALTER TABLE account_keys ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE account_keys FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON account_keys
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON account_keys TO senseplane_app;
    END IF;
  END $$`.execute(db);
  for (const t of ["segments", "clip_segments"]) {
    await db.schema.alterTable(t).addColumn("enc_version", "integer").addColumn("enc_iv", "bytea").execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const t of ["segments", "clip_segments"]) {
    await db.schema.alterTable(t).dropColumn("enc_version").dropColumn("enc_iv").execute();
  }
  await db.schema.dropTable("account_keys").execute();
}
