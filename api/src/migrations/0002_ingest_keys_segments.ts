// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

async function isolate(db: Kysely<unknown>, table: string, force: boolean) {
  await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
  if (force) await sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON ${sql.table(table)}
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("accounts")
    .addColumn("retention_days", "integer", (c) => c.notNull().defaultTo(7).check(sql`retention_days >= 1`))
    .execute();

  await db.schema
    .alterTable("sources")
    .addColumn("location", "text")
    .addColumn("senses", sql`text[]`, (c) => c.notNull().defaultTo(sql`'{video}'`))
    .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
    .addColumn("record_audio", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("retention_days", "integer", (c) => c.check(sql`retention_days >= 1`))
    .execute();

  // API keys. RLS is enabled but not forced: the owner-defined lookup function
  // below can find a key before the account is known; the app role cannot.
  await db.schema
    .createTable("api_keys")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("key_hash", "text", (c) => c.notNull().unique())
    .addColumn("prefix", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("revoked_at", "timestamptz")
    .execute();
  await isolate(db, "api_keys", false);
  await sql`CREATE FUNCTION auth_api_key(hash text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
    $$ SELECT account_id FROM api_keys WHERE key_hash = hash AND revoked_at IS NULL $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION auth_api_key(text) FROM PUBLIC`.execute(db);

  // Segment index, built from media.segment.written (ADR 0010).
  await db.schema
    .createTable("segments")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
    .addColumn("key", "text", (c) => c.notNull().unique())
    .addColumn("init_key", "text", (c) => c.notNull())
    .addColumn("start_at", "timestamptz", (c) => c.notNull())
    .addColumn("duration_ms", "integer", (c) => c.notNull())
    .addColumn("bytes", "bigint", (c) => c.notNull())
    .addColumn("codec", "text", (c) => c.notNull())
    .addColumn("has_audio", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("indexed_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("segments_source_start_idx").on("segments").columns(["source_id", "start_at"]).execute();
  await isolate(db, "segments", true);

  // Instance-wide secrets (e.g. the generated ingest signing key). Not account data.
  await db.schema
    .createTable("instance_secrets")
    .addColumn("name", "text", (c) => c.primaryKey())
    .addColumn("value", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();

  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON api_keys, segments TO senseplane_app;
      GRANT SELECT, INSERT ON instance_secrets TO senseplane_app;
      GRANT USAGE ON SEQUENCE segments_id_seq TO senseplane_app;
      GRANT EXECUTE ON FUNCTION auth_api_key(text) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("instance_secrets").execute();
  await db.schema.dropTable("segments").execute();
  await sql`DROP FUNCTION auth_api_key(text)`.execute(db);
  await db.schema.dropTable("api_keys").execute();
  await db.schema.alterTable("sources").dropColumn("location").dropColumn("senses").dropColumn("status")
    .dropColumn("record_audio").dropColumn("retention_days").execute();
  await db.schema.alterTable("accounts").dropColumn("retention_days").execute();
}
