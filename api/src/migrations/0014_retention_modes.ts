// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type Kysely, sql } from "kysely";

// Retention modes (ADR 0032): `days` (default, the ADR 0016 behaviour, where a
// null number of days keeps raw footage until deleted) or `fill` (keep as much
// raw footage as a byte cap holds, oldest deleted first). Sources inherit the
// account's mode unless they override it. Snapshot sizes count towards
// storage.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("accounts").alterColumn("retention_days", (c) => c.dropNotNull()).execute();
  await db.schema.alterTable("accounts").addColumn("retention_mode", "text", (c) => c.notNull().defaultTo("days")).execute();
  await db.schema.alterTable("accounts").addColumn("retention_max_bytes", "bigint").execute();
  await db.schema.alterTable("sources").addColumn("retention_mode", "text").execute();
  await db.schema.alterTable("sources").addColumn("retention_max_bytes", "bigint").execute();
  await db.schema.alterTable("events").addColumn("snapshot_bytes", "integer").execute();

  // Days mode only; fill-mode sources are swept by bytes instead.
  await sql`CREATE OR REPLACE FUNCTION raw_retention_targets() RETURNS TABLE(account_id uuid, source_id text, retention_days integer)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT s.account_id, s.id, coalesce(s.retention_days, a.retention_days)
      FROM sources s JOIN accounts a ON a.id = s.account_id
      WHERE coalesce(s.retention_mode, a.retention_mode) = 'days'
        AND coalesce(s.retention_days, a.retention_days) IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM segments g
          WHERE g.source_id = s.id AND g.start_at < now() - make_interval(days => coalesce(s.retention_days, a.retention_days))
        )
    $$`.execute(db);
  await sql`CREATE FUNCTION fill_retention_accounts() RETURNS TABLE(account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT a.id FROM accounts a WHERE a.deleted_at IS NULL AND (a.retention_mode = 'fill'
        OR EXISTS (SELECT 1 FROM sources s WHERE s.account_id = a.id AND s.retention_mode = 'fill'))
    $$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION storage_bytes_by_account() RETURNS TABLE (account_id uuid, bytes bigint)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT a.id, coalesce((SELECT sum(bytes) FROM segments s WHERE s.account_id = a.id), 0)::bigint
                 + coalesce((SELECT sum(bytes) FROM clips c WHERE c.account_id = a.id), 0)::bigint
                 + coalesce((SELECT sum(snapshot_bytes) FROM events e WHERE e.account_id = a.id), 0)::bigint
      FROM accounts a WHERE a.deleted_at IS NULL
    $$`.execute(db);
  for (const f of ["raw_retention_targets()", "fill_retention_accounts()"]) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
    await sql.raw(`ALTER FUNCTION ${f} SET row_security = off`).execute(db);
  }
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT EXECUTE ON FUNCTION fill_retention_accounts() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS fill_retention_accounts()`.execute(db);
  for (const [t, c] of [["events", "snapshot_bytes"], ["sources", "retention_max_bytes"], ["sources", "retention_mode"], ["accounts", "retention_max_bytes"], ["accounts", "retention_mode"]] as const) {
    await db.schema.alterTable(t).dropColumn(c).execute();
  }
}
