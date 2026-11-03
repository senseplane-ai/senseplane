// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The readings webhook (ADR 0071): a sensor's integration token can carry a
// signing secret (sealed like webhook secrets). With one, every push must be
// signed the way Senseplane signs its own webhooks, and a signature is taken
// once: the ones seen in the last minutes are kept to refuse a replay.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("ingest_tokens").addColumn("signing_secret", "text").execute();

  await db.schema
    .createTable("reading_signatures")
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("token_id", "text", (c) => c.notNull().references("ingest_tokens.id").onDelete("cascade"))
    .addColumn("mac", "text", (c) => c.notNull())
    .addColumn("seen_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("reading_signatures_pkey", ["token_id", "mac"])
    .execute();
  await db.schema.createIndex("reading_signatures_seen").on("reading_signatures").columns(["account_id", "seen_at"]).execute();
  await sql`ALTER TABLE reading_signatures ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE reading_signatures FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON reading_signatures
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);

  // The token's id and sealed signing secret too, so the check needs no second lookup.
  await sql`DROP FUNCTION auth_integration_token(text)`.execute(db);
  await sql`CREATE FUNCTION auth_integration_token(hash text) RETURNS TABLE(source_id text, account_id uuid, token_id text, signing_secret text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT t.source_id, t.account_id, t.id, t.signing_secret FROM ingest_tokens t
        JOIN accounts a ON a.id = t.account_id
        JOIN sources s ON s.id = t.source_id AND s.account_id = t.account_id
      WHERE t.token_hash = hash AND t.revoked_at IS NULL AND a.deleted_at IS NULL AND s.type = 'sensor'
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION auth_integration_token(text) FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, DELETE ON reading_signatures TO senseplane_app;
      GRANT EXECUTE ON FUNCTION auth_integration_token(text) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION auth_integration_token(text)`.execute(db);
  await sql`CREATE FUNCTION auth_integration_token(hash text) RETURNS TABLE(source_id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT t.source_id, t.account_id FROM ingest_tokens t
        JOIN accounts a ON a.id = t.account_id
        JOIN sources s ON s.id = t.source_id AND s.account_id = t.account_id
      WHERE t.token_hash = hash AND t.revoked_at IS NULL AND a.deleted_at IS NULL AND s.type = 'sensor'
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION auth_integration_token(text) FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT EXECUTE ON FUNCTION auth_integration_token(text) TO senseplane_app;
    END IF;
  END $$`.execute(db);
  await db.schema.dropTable("reading_signatures").execute();
  await db.schema.alterTable("ingest_tokens").dropColumn("signing_secret").execute();
}
