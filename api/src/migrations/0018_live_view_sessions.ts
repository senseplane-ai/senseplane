// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Live view sessions (ADR 0042): one row per viewer token issued. The media
// plane reports joins and leaves in its room callbacks; `metered_until` is how far
// the viewing time has been written to usage_records (live_view_ms). The
// owner-defined function lists sessions the media plane stopped reporting
// (node restarted), so the API can close and meter them across accounts.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("live_sessions")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
    .addColumn("actor", "text", (c) => c.notNull())
    .addColumn("audio", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("joined_at", "timestamptz")
    .addColumn("last_seen_at", "timestamptz")
    .addColumn("metered_until", "timestamptz")
    .addColumn("ended_at", "timestamptz")
    .addColumn("end_reason", "text")
    .execute();
  await sql`CREATE INDEX live_sessions_open ON live_sessions (account_id, source_id) WHERE ended_at IS NULL`.execute(db);
  await sql`ALTER TABLE live_sessions ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE live_sessions FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON live_sessions
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);

  await sql`CREATE FUNCTION stale_live_sessions(cutoff timestamptz) RETURNS TABLE (account_id uuid, id text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT account_id, id FROM live_sessions
      WHERE ended_at IS NULL AND (
        (joined_at IS NOT NULL AND coalesce(last_seen_at, joined_at) < cutoff)
        OR (joined_at IS NULL AND expires_at < now())
      )
      LIMIT 500
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION stale_live_sessions(timestamptz) FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON live_sessions TO senseplane_app;
      GRANT EXECUTE ON FUNCTION stale_live_sessions(timestamptz) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION stale_live_sessions(timestamptz)`.execute(db);
  await db.schema.dropTable("live_sessions").execute();
}
