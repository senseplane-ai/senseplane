// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type Kysely, sql } from "kysely";

// Console sign-in (ADR 0031): users with a password and/or Google/GitHub
// identities, console sessions as expiring API keys, and an optional plan
// label on accounts for a deployment's quota provider.
//
// users and user_identities are a global directory (sign-in looks them up
// before any account is known), so they are not row-isolated; only the API's
// sign-in code reads them, and each row points at exactly one account.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("accounts").addColumn("plan", "text").execute();
  await db.schema.alterTable("api_keys").addColumn("expires_at", "timestamptz").execute();

  await db.schema.createTable("users")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("email", "text", (c) => c.notNull().unique())
    .addColumn("password_hash", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createTable("user_identities")
    .addColumn("provider", "text", (c) => c.notNull())
    .addColumn("provider_user_id", "text", (c) => c.notNull())
    .addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("email", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("user_identities_pk", ["provider", "provider_user_id"])
    .execute();

  // Expired console sessions stop authenticating.
  await sql`CREATE OR REPLACE FUNCTION auth_api_key_principal(hash text) RETURNS TABLE (account_id uuid, agent_id text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT k.account_id, k.agent_id FROM api_keys k
        JOIN accounts a ON a.id = k.account_id
        LEFT JOIN agents g ON g.id = k.agent_id
      WHERE k.key_hash = hash AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
        AND a.deleted_at IS NULL AND (k.agent_id IS NULL OR g.revoked_at IS NULL)
    $$`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION auth_api_key(hash text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
    $$ SELECT account_id FROM api_keys WHERE key_hash = hash AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) $$`.execute(db);

  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON users, user_identities TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("user_identities").execute();
  await db.schema.dropTable("users").execute();
  await db.schema.alterTable("api_keys").dropColumn("expires_at").execute();
  await db.schema.alterTable("accounts").dropColumn("plan").execute();
}
