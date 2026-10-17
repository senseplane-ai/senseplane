// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Connected apps (ADR 0048): an MCP client someone approves on the consent
// page becomes an agent of kind `app`, named after the client and keyed by
// (client name, redirect host) so reconnecting reuses it. Grants gain
// `abilities` (set watches, see history); existing grants keep both. A
// single-use connect code hands the MCP service the app's key without the
// browser ever seeing it.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("agents")
    .addColumn("kind", "text", (c) => c.notNull().defaultTo("key"))
    .addColumn("client_name", "text")
    .addColumn("client_host", "text")
    .addColumn("connected_at", "timestamptz")
    .execute();
  await sql`CREATE INDEX agents_app ON agents (account_id, client_name, client_host) WHERE kind = 'app' AND revoked_at IS NULL`.execute(db);

  await db.schema.alterTable("grants")
    .addColumn("abilities", sql`text[]`, (c) => c.notNull().defaultTo(sql`'{watch,history}'::text[]`))
    .execute();

  await db.schema.createTable("agent_connect_codes")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("agent_id", "text", (c) => c.notNull().references("agents.id").onDelete("cascade"))
    .addColumn("code_hash", "text", (c) => c.notNull().unique())
    .addColumn("binding", "text", (c) => c.notNull())
    .addColumn("client_name", "text", (c) => c.notNull())
    .addColumn("client_host", "text", (c) => c.notNull())
    .addColumn("approved_by", "text")
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("used_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`ALTER TABLE agent_connect_codes ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE agent_connect_codes FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON agent_connect_codes
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);

  // "Last active" on the Agents page reads the newest audit entry per agent.
  await sql`CREATE INDEX audit_actor_at ON audit_log (account_id, actor, occurred_at DESC)`.execute(db);

  // Code → (id, account) before the account is known, like invites.
  await sql`CREATE FUNCTION connect_code_by_hash(hash text) RETURNS TABLE (id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT c.id, c.account_id FROM agent_connect_codes c JOIN accounts a ON a.id = c.account_id
      WHERE c.code_hash = hash AND a.deleted_at IS NULL
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION connect_code_by_hash(text) FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON agent_connect_codes TO senseplane_app;
      GRANT EXECUTE ON FUNCTION connect_code_by_hash(text) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION connect_code_by_hash(text)`.execute(db);
  await sql`DROP INDEX audit_actor_at`.execute(db);
  await db.schema.dropTable("agent_connect_codes").execute();
  await db.schema.alterTable("grants").dropColumn("abilities").execute();
  await sql`DROP INDEX agents_app`.execute(db);
  await db.schema.alterTable("agents").dropColumn("kind").dropColumn("client_name").dropColumn("client_host").dropColumn("connected_at").execute();
}
