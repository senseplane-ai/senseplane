// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Key rotation (ADR 0066): the jobs find, across accounts, which have keys and
// which are rotating (more than one version), without reading any key.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION account_key_versions() RETURNS TABLE (account_id uuid, versions integer, current integer, current_since timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT k.account_id, count(*)::integer, max(k.version), max(k.created_at)
      FROM account_keys k JOIN accounts a ON a.id = k.account_id
      WHERE a.deleted_at IS NULL GROUP BY k.account_id
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION account_key_versions() FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT EXECUTE ON FUNCTION account_key_versions() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION account_key_versions()`.execute(db);
}
