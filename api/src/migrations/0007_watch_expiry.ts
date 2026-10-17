// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("watches").addColumn("expires_at", "timestamptz").execute();
  // Watches whose time is up, across accounts: only ids, for the API's sweeper.
  await sql`CREATE FUNCTION expired_watches() RETURNS TABLE (id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT id, account_id FROM watches WHERE expires_at <= now() AND status <> 'expired' LIMIT 500
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION expired_watches() FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT EXECUTE ON FUNCTION expired_watches() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION expired_watches()`.execute(db);
  await db.schema.alterTable("watches").dropColumn("expires_at").execute();
}
