// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// WHIP bearer tokens (spec/media/whip.md, ADR 0034). Only a SHA-256 hash is
// stored. RLS is forced for the app role; the owner-defined lookup function
// below resolves a (hash, source) pair before the account is known, so the
// media plane's authorise call doesn't need an account id.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("ingest_tokens")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("source_id", "text", (c) => c.notNull().references("sources.id").onDelete("cascade"))
    .addColumn("token_hash", "text", (c) => c.notNull().unique())
    .addColumn("prefix", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("revoked_at", "timestamptz")
    .execute();
  await db.schema.createIndex("ingest_tokens_source").on("ingest_tokens").columns(["account_id", "source_id"]).execute();
  await sql`ALTER TABLE ingest_tokens ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE ingest_tokens FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON ingest_tokens
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);

  await sql`CREATE FUNCTION auth_ingest_token(hash text, source text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT t.account_id FROM ingest_tokens t
        JOIN accounts a ON a.id = t.account_id
        JOIN sources s ON s.id = t.source_id AND s.account_id = t.account_id
      WHERE t.token_hash = hash AND t.source_id = source AND t.revoked_at IS NULL
        AND a.deleted_at IS NULL AND s.type = 'whip'
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION auth_ingest_token(text, text) FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON ingest_tokens TO senseplane_app;
      GRANT EXECUTE ON FUNCTION auth_ingest_token(text, text) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION auth_ingest_token(text, text)`.execute(db);
  await db.schema.dropTable("ingest_tokens").execute();
}
