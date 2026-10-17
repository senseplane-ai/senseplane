// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("clips")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("source_id", "text", (c) => c.notNull())
    .addColumn("title", "text")
    .addColumn("from_at", "timestamptz", (c) => c.notNull())
    .addColumn("to_at", "timestamptz", (c) => c.notNull())
    .addColumn("duration_ms", "integer", (c) => c.notNull())
    .addColumn("bytes", "bigint", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  // Clip segments are copies under clips/, so a clip survives raw deletion
  // and even the deletion of its source.
  await db.schema
    .createTable("clip_segments")
    .addColumn("clip_id", "text", (c) => c.notNull().references("clips.id").onDelete("cascade"))
    .addColumn("seq", "integer", (c) => c.notNull())
    .addColumn("account_id", "uuid", (c) => c.notNull())
    .addColumn("key", "text", (c) => c.notNull())
    .addColumn("init_key", "text", (c) => c.notNull())
    .addColumn("start_at", "timestamptz", (c) => c.notNull())
    .addColumn("duration_ms", "integer", (c) => c.notNull())
    .addPrimaryKeyConstraint("clip_segments_pk", ["clip_id", "seq"])
    .execute();
  for (const table of ["clips", "clip_segments"]) {
    await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`.execute(db);
    await sql`CREATE POLICY account_isolation ON ${sql.table(table)}
      USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  }

  // The retention sweeper needs to know which sources have raw data past their
  // retention before it knows the account: an owner-defined function returns
  // only (account, source, days, oldest) and nothing else (ADR 0016).
  await sql`CREATE FUNCTION raw_retention_targets() RETURNS TABLE(account_id uuid, source_id text, retention_days integer)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT s.account_id, s.id, coalesce(s.retention_days, a.retention_days)
      FROM sources s JOIN accounts a ON a.id = s.account_id
      WHERE EXISTS (
        SELECT 1 FROM segments g
        WHERE g.source_id = s.id AND g.start_at < now() - make_interval(days => coalesce(s.retention_days, a.retention_days))
      )
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION raw_retention_targets() FROM PUBLIC`.execute(db);
  // RLS on sources/segments is FORCED, which applies to the owner too; the
  // function needs to see every account, so it runs with row security off.
  await sql`ALTER FUNCTION raw_retention_targets() SET row_security = off`.execute(db);

  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON clips, clip_segments TO senseplane_app;
      GRANT EXECUTE ON FUNCTION raw_retention_targets() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION raw_retention_targets()`.execute(db);
  await db.schema.dropTable("clip_segments").execute();
  await db.schema.dropTable("clips").execute();
}
