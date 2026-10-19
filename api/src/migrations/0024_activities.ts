// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Activities (ADR 0057): one thing, in one place, from a start to an end, as
// the brain reports them (presence, sound, watch) or a history check finds
// them. Sources get a site, so questions can be grouped across places. The
// owner-defined function lets the sweeper close activities whose brain went
// quiet, across accounts.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sources").addColumn("site", "text").execute();
  await db.schema
    .createTable("activities")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
    .addColumn("activity_key", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind IN ('presence', 'sound', 'watch')`))
    .addColumn("label", "text", (c) => c.notNull())
    .addColumn("zone", "text")
    .addColumn("watch_id", "text")
    .addColumn("started_at", "timestamptz", (c) => c.notNull())
    .addColumn("last_seen_at", "timestamptz", (c) => c.notNull())
    .addColumn("ended_at", "timestamptz")
    .addColumn("peak_count", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("confidence", "real")
    .addColumn("verified", "boolean")
    .addColumn("summary", "text")
    .addColumn("checked", "boolean", (c) => c.notNull().defaultTo(false)) // found by a history check, not live
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("activities_account_key", ["account_id", "activity_key"])
    .execute();
  await sql`CREATE INDEX activities_what ON activities (account_id, kind, label, started_at)`.execute(db);
  await sql`CREATE INDEX activities_source ON activities (source_id, started_at)`.execute(db);
  await sql`CREATE INDEX activities_open ON activities (last_seen_at) WHERE ended_at IS NULL`.execute(db);
  await sql`ALTER TABLE activities ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE activities FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON activities
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);

  // Open activities with no update for `seconds` end where they were last seen (a brain stopped, a camera moved).
  await sql`CREATE FUNCTION close_stale_activities(seconds integer) RETURNS integer
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      WITH closed AS (
        UPDATE activities SET ended_at = last_seen_at
        WHERE ended_at IS NULL AND last_seen_at < now() - make_interval(secs => seconds)
        RETURNING 1
      ) SELECT count(*)::integer FROM closed
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION close_stale_activities(integer) FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON activities TO senseplane_app;
      GRANT EXECUTE ON FUNCTION close_stale_activities(integer) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION close_stale_activities(integer)`.execute(db);
  await db.schema.dropTable("activities").execute();
  await db.schema.alterTable("sources").dropColumn("site").execute();
}
