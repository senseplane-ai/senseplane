// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Privacy blurring (ADR 0068), the rest:
// - the agent that made a watch: when it only sees the watch's cameras
//   blurred, the watch's model checks are blurred too;
// - the accounts with cameras, so a job can send every camera's blurring
//   to the brain again (a publish that failed never leaves it stale).
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("watches").addColumn("created_by_agent", "text").execute();
  await sql`CREATE FUNCTION accounts_with_cameras() RETURNS TABLE (account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT DISTINCT s.account_id FROM sources s JOIN accounts a ON a.id = s.account_id
      WHERE a.deleted_at IS NULL AND s.type <> 'sensor'
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION accounts_with_cameras() FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT EXECUTE ON FUNCTION accounts_with_cameras() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION accounts_with_cameras()`.execute(db);
  await db.schema.alterTable("watches").dropColumn("created_by_agent").execute();
}
