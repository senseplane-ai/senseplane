// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("accounts").addColumn("kind", "text", (c) => c.notNull().defaultTo("standard")).execute();
  // Not account data (an account is created per session), so no RLS; only the
  // API reads it, by session id + token hash (ADR 0021).
  await db.schema
    .createTable("demo_sessions")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid")
    .addColumn("source_id", "text")
    .addColumn("watch_ids", sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'`))
    .addColumn("token_hash", "text", (c) => c.notNull())
    .addColumn("ip_hash", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("ended_at", "timestamptz")
    .addColumn("capped_at", "timestamptz")
    .addColumn("purge_after", "timestamptz")
    .addColumn("purged_at", "timestamptz")
    .addColumn("vlm_calls", "integer", (c) => c.notNull().defaultTo(0)) // kept after deletion, for the daily budget
    .execute();
  await db.schema.createIndex("demo_sessions_ip_day").on("demo_sessions").columns(["ip_hash", "created_at"]).execute();
  // Model calls made by all demo accounts today (for the global daily budget).
  await sql`CREATE FUNCTION demo_vlm_calls_today() RETURNS bigint
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT (SELECT coalesce(sum(u.quantity), 0) FROM usage_records u JOIN accounts a ON a.id = u.account_id
              WHERE a.kind = 'demo' AND u.kind = 'vlm_calls' AND u.at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
           + (SELECT coalesce(sum(vlm_calls), 0) FROM demo_sessions
              WHERE purged_at IS NOT NULL AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION demo_vlm_calls_today() FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON demo_sessions TO senseplane_app;
      GRANT EXECUTE ON FUNCTION demo_vlm_calls_today() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION demo_vlm_calls_today()`.execute(db);
  await db.schema.dropTable("demo_sessions").execute();
  await db.schema.alterTable("accounts").dropColumn("kind").execute();
}
