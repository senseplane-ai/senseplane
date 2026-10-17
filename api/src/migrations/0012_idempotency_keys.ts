// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

// Stored first responses for Idempotency-Key on create routes (ADR 0030); kept 24 h.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("idempotency_keys")
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("key", "text", (c) => c.notNull())
    .addColumn("route", "text", (c) => c.notNull())
    .addColumn("request_hash", "text", (c) => c.notNull())
    .addColumn("status_code", "integer", (c) => c.notNull())
    .addColumn("response", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("idempotency_keys_pk", ["account_id", "key"])
    .execute();
  await db.schema.createIndex("idempotency_keys_created").on("idempotency_keys").column("created_at").execute();
  await sql`ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON idempotency_keys
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  // Expiry runs across accounts, so it is an owner-defined function.
  await sql`CREATE FUNCTION expire_idempotency_keys() RETURNS integer
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      WITH d AS (DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours' RETURNING 1) SELECT count(*)::integer FROM d
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION expire_idempotency_keys() FROM PUBLIC`.execute(db);
  await sql`ALTER FUNCTION expire_idempotency_keys() SET row_security = off`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, DELETE ON idempotency_keys TO senseplane_app;
      GRANT EXECUTE ON FUNCTION expire_idempotency_keys() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS expire_idempotency_keys()`.execute(db);
  await db.schema.dropTable("idempotency_keys").execute();
}
