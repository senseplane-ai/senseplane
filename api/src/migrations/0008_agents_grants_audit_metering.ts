// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Agents and grants (ADR 0024), the audit log, metering details and
// account deletion (ADR 0025).
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

async function isolate(db: Kysely<unknown>, table: string) {
  await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON ${sql.table(table)}
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("agents")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("revoked_at", "timestamptz")
    .execute();
  await isolate(db, "agents");
  await db.schema.alterTable("api_keys").addColumn("agent_id", "text", (c) => c.references("agents.id").onDelete("cascade")).execute();

  await db.schema.createTable("grants")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("agent_id", "text", (c) => c.notNull().references("agents.id").onDelete("cascade"))
    .addColumn("source_ids", sql`text[]`, (c) => c.notNull())
    .addColumn("senses", sql`text[]`, (c) => c.notNull())
    .addColumn("window_from", "timestamptz")
    .addColumn("window_to", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("grants_agent").on("grants").column("agent_id").execute();
  await isolate(db, "grants");

  await db.schema.createTable("audit_log")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("actor", "text", (c) => c.notNull())
    .addColumn("action", "text", (c) => c.notNull())
    .addColumn("target", "text", (c) => c.notNull())
    .addColumn("status", "integer")
    .addColumn("details", "jsonb")
    .addColumn("occurred_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("audit_account_at").on("audit_log").columns(["account_id", "occurred_at"]).execute();
  await isolate(db, "audit_log");

  // Metering detail (resolution, AI-check kind) and an idempotency key (hourly storage samples).
  await db.schema.alterTable("usage_records").addColumn("detail", "text").addColumn("dedupe_key", "text").execute();
  await sql`CREATE UNIQUE INDEX usage_dedupe ON usage_records (account_id, dedupe_key) WHERE dedupe_key IS NOT NULL`.execute(db);
  await db.schema.alterTable("accounts").addColumn("deleted_at", "timestamptz").execute();

  // Key → account and agent (null for account keys). Revoked agents and deleted accounts don't authenticate.
  await sql`CREATE FUNCTION auth_api_key_principal(hash text) RETURNS TABLE (account_id uuid, agent_id text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT k.account_id, k.agent_id FROM api_keys k
        JOIN accounts a ON a.id = k.account_id
        LEFT JOIN agents g ON g.id = k.agent_id
      WHERE k.key_hash = hash AND k.revoked_at IS NULL AND a.deleted_at IS NULL AND (k.agent_id IS NULL OR g.revoked_at IS NULL)
    $$`.execute(db);
  // Stored bytes per account (raw segments and clips), for the hourly storage sample.
  await sql`CREATE FUNCTION storage_bytes_by_account() RETURNS TABLE (account_id uuid, bytes bigint)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT a.id, coalesce((SELECT sum(bytes) FROM segments s WHERE s.account_id = a.id), 0)::bigint
                 + coalesce((SELECT sum(bytes) FROM clips c WHERE c.account_id = a.id), 0)::bigint
      FROM accounts a WHERE a.deleted_at IS NULL
    $$`.execute(db);
  await sql`CREATE FUNCTION accounts_to_delete() RETURNS TABLE (id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT id FROM accounts WHERE deleted_at IS NOT NULL LIMIT 50
    $$`.execute(db);
  await sql`CREATE FUNCTION accounts_with_limits() RETURNS TABLE (id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT id FROM accounts WHERE deleted_at IS NULL
    $$`.execute(db);
  for (const f of ["auth_api_key_principal(text)", "storage_bytes_by_account()", "accounts_to_delete()", "accounts_with_limits()"]) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
  }
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON agents, grants TO senseplane_app;
      GRANT SELECT, INSERT, DELETE ON audit_log TO senseplane_app;
      GRANT USAGE ON SEQUENCE audit_log_id_seq TO senseplane_app;
      GRANT EXECUTE ON FUNCTION auth_api_key_principal(text), storage_bytes_by_account(), accounts_to_delete(), accounts_with_limits() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const f of ["auth_api_key_principal(text)", "storage_bytes_by_account()", "accounts_to_delete()", "accounts_with_limits()"]) {
    await sql.raw(`DROP FUNCTION ${f}`).execute(db);
  }
  await db.schema.alterTable("accounts").dropColumn("deleted_at").execute();
  await sql`DROP INDEX usage_dedupe`.execute(db);
  await db.schema.alterTable("usage_records").dropColumn("detail").dropColumn("dedupe_key").execute();
  await db.schema.dropTable("audit_log").execute();
  await db.schema.dropTable("grants").execute();
  await db.schema.alterTable("api_keys").dropColumn("agent_id").execute();
  await db.schema.dropTable("agents").execute();
}
