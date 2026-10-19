// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Condition and digest watches (ADR 0057) are checked by the API on a
// schedule: when each was last checked, and whether its condition held then
// (it fires when the condition starts to hold). The owner-defined function
// lists them across accounts for the scheduler.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("watches")
    .addColumn("last_checked_at", "timestamptz")
    .addColumn("last_condition", "boolean")
    .execute();
  await sql`CREATE FUNCTION scheduled_watches() RETURNS TABLE(account_id uuid, id text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT w.account_id, w.id FROM watches w JOIN accounts a ON a.id = w.account_id
      WHERE w.status = 'active' AND a.deleted_at IS NULL AND w.compiled->'trigger'->>'type' IN ('condition', 'digest')
        AND (w.expires_at IS NULL OR w.expires_at > now())
      LIMIT 5000
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION scheduled_watches() FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT EXECUTE ON FUNCTION scheduled_watches() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION scheduled_watches()`.execute(db);
  await db.schema.alterTable("watches").dropColumn("last_condition").dropColumn("last_checked_at").execute();
}
