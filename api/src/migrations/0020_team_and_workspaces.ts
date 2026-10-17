// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type Kysely, sql } from "kysely";

// Teams and workspaces (ADR 0044): a user belongs to one or more accounts
// through memberships with a role (owner, admin, member, viewer), and joins
// another account through a single-use invite. A console session remembers
// its user, so the role is read on every request.
//
// memberships and invites are account data (row-isolated); the owner-defined
// functions below are the only cross-account reads: a user's memberships (at
// sign-in and for the workspace switcher) and an invite by its token hash.
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("accounts").addColumn("time_zone", "text", (c) => c.notNull().defaultTo("UTC")).execute();
  await db.schema.alterTable("users").addColumn("name", "text").execute();
  // users.account_id becomes the workspace a sign-in opens (the last one used),
  // so deleting a workspace keeps the people in it.
  await sql`ALTER TABLE users ALTER COLUMN account_id DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE users DROP CONSTRAINT users_account_id_fkey`.execute(db);
  await sql`ALTER TABLE users ADD CONSTRAINT users_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL`.execute(db);

  await db.schema.createTable("memberships")
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("user_id", "text", (c) => c.notNull().references("users.id").onDelete("cascade"))
    .addColumn("role", "text", (c) => c.notNull().check(sql`role IN ('owner', 'admin', 'member', 'viewer')`))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("memberships_pk", ["account_id", "user_id"])
    .execute();
  await db.schema.createIndex("memberships_user").on("memberships").column("user_id").execute();

  await db.schema.createTable("invites")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("email", "text", (c) => c.notNull())
    .addColumn("role", "text", (c) => c.notNull().check(sql`role IN ('owner', 'admin', 'member', 'viewer')`))
    .addColumn("token_hash", "text", (c) => c.notNull().unique())
    .addColumn("invited_by", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("accepted_at", "timestamptz")
    .addColumn("accepted_by", "text")
    .addColumn("revoked_at", "timestamptz")
    .execute();
  await db.schema.createIndex("invites_account").on("invites").columns(["account_id", "created_at"]).execute();

  for (const table of ["memberships", "invites"]) {
    await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`.execute(db);
    await sql`CREATE POLICY account_isolation ON ${sql.table(table)}
      USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  }

  // Every existing user owns the account they were created in.
  await sql`INSERT INTO memberships (account_id, user_id, role, created_at)
    SELECT account_id, id, 'owner', created_at FROM users WHERE account_id IS NOT NULL`.execute(db);

  // Console sessions belong to a user. Existing sessions are kept when their
  // account has exactly one user; the rest sign in again.
  await db.schema.alterTable("api_keys").addColumn("user_id", "text", (c) => c.references("users.id").onDelete("cascade")).execute();
  await sql`UPDATE api_keys k SET user_id = u.id FROM users u
    WHERE k.name = 'console session' AND k.user_id IS NULL AND u.account_id = k.account_id
      AND (SELECT count(*) FROM users x WHERE x.account_id = k.account_id) = 1`.execute(db);
  await sql`UPDATE api_keys SET revoked_at = now() WHERE name = 'console session' AND user_id IS NULL AND revoked_at IS NULL`.execute(db);

  // A key's principal gains its user and role. A session stops working the
  // moment its user leaves the account.
  await sql`DROP FUNCTION auth_api_key_principal(text)`.execute(db);
  await sql`CREATE FUNCTION auth_api_key_principal(hash text) RETURNS TABLE (account_id uuid, agent_id text, user_id text, role text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT k.account_id, k.agent_id, k.user_id, m.role FROM api_keys k
        JOIN accounts a ON a.id = k.account_id
        LEFT JOIN agents g ON g.id = k.agent_id
        LEFT JOIN memberships m ON m.account_id = k.account_id AND m.user_id = k.user_id
      WHERE k.key_hash = hash AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
        AND a.deleted_at IS NULL AND (k.agent_id IS NULL OR g.revoked_at IS NULL)
        AND (k.user_id IS NULL OR m.role IS NOT NULL)
    $$`.execute(db);
  await sql`CREATE FUNCTION user_memberships(uid text) RETURNS TABLE (account_id uuid, account_name text, role text, created_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT m.account_id, a.name, m.role, m.created_at FROM memberships m
        JOIN accounts a ON a.id = m.account_id
      WHERE m.user_id = uid AND a.deleted_at IS NULL
      ORDER BY m.created_at, m.account_id
    $$`.execute(db);
  await sql`CREATE FUNCTION invite_by_token(hash text) RETURNS TABLE (id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT i.id, i.account_id FROM invites i JOIN accounts a ON a.id = i.account_id
      WHERE i.token_hash = hash AND a.deleted_at IS NULL
    $$`.execute(db);
  for (const f of ["auth_api_key_principal(text)", "user_memberships(text)", "invite_by_token(text)"]) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
  }
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, invites TO senseplane_app;
      GRANT EXECUTE ON FUNCTION auth_api_key_principal(text), user_memberships(text), invite_by_token(text) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION invite_by_token(text)`.execute(db);
  await sql`DROP FUNCTION user_memberships(text)`.execute(db);
  await sql`DROP FUNCTION auth_api_key_principal(text)`.execute(db);
  await sql`CREATE FUNCTION auth_api_key_principal(hash text) RETURNS TABLE (account_id uuid, agent_id text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT k.account_id, k.agent_id FROM api_keys k
        JOIN accounts a ON a.id = k.account_id
        LEFT JOIN agents g ON g.id = k.agent_id
      WHERE k.key_hash = hash AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
        AND a.deleted_at IS NULL AND (k.agent_id IS NULL OR g.revoked_at IS NULL)
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION auth_api_key_principal(text) FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT EXECUTE ON FUNCTION auth_api_key_principal(text) TO senseplane_app;
    END IF;
  END $$`.execute(db);
  await db.schema.alterTable("api_keys").dropColumn("user_id").execute();
  await db.schema.dropTable("invites").execute();
  await db.schema.dropTable("memberships").execute();
  await sql`ALTER TABLE users DROP CONSTRAINT users_account_id_fkey`.execute(db);
  await sql`ALTER TABLE users ADD CONSTRAINT users_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE`.execute(db);
  await sql`ALTER TABLE users ALTER COLUMN account_id SET NOT NULL`.execute(db);
  await db.schema.alterTable("users").dropColumn("name").execute();
  await db.schema.alterTable("accounts").dropColumn("time_zone").execute();
}
