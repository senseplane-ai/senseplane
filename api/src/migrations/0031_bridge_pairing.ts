// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Pairing a bridge with a code (ADR 0061), like a TV app's sign-in: the box
// asks for a code, a person enters it in the console, and the box collects
// its bridge token once. A pairing belongs to no account until it is approved,
// so the table has row security with no policy and is reached only through
// the functions below.
import { type Kysely, sql } from "kysely";

const FUNCTIONS = [
  "bridge_pairing_start(text, text, text, timestamptz)",
  "bridge_pairing_find(text)",
  "bridge_pairing_approve(text, uuid, text, text)",
  "bridge_pairing_take(text)",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("bridge_pairings")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("device_code_hash", "text", (c) => c.notNull().unique())
    .addColumn("user_code", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("account_id", "uuid", (c) => c.references("accounts.id").onDelete("cascade"))
    .addColumn("bridge_id", "text", (c) => c.references("bridges.id").onDelete("cascade"))
    // The bridge token, encrypted (SECRETS_ENCRYPTION_KEY), until the box collects it.
    .addColumn("token_sealed", "text")
    .addColumn("approved_at", "timestamptz")
    .addColumn("taken_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  // A code is unique among the pairings still waiting.
  await sql`CREATE UNIQUE INDEX bridge_pairings_waiting_code ON bridge_pairings (user_code) WHERE approved_at IS NULL`.execute(db);
  await sql`ALTER TABLE bridge_pairings ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE bridge_pairings FORCE ROW LEVEL SECURITY`.execute(db);

  const definer = sql.raw("SECURITY DEFINER SET search_path = public SET row_security = off");
  await sql`CREATE FUNCTION bridge_pairing_start(device_hash text, code text, box_name text, until timestamptz) RETURNS boolean
    LANGUAGE plpgsql VOLATILE ${definer} AS $$
    BEGIN
      DELETE FROM bridge_pairings WHERE expires_at < now() - interval '1 day';
      INSERT INTO bridge_pairings (device_code_hash, user_code, name, expires_at) VALUES (device_hash, code, box_name, until);
      RETURN true;
    EXCEPTION WHEN unique_violation THEN
      RETURN false;
    END $$`.execute(db);
  // What the console shows before approving: the box's name, while the code is still waiting.
  await sql`CREATE FUNCTION bridge_pairing_find(code text) RETURNS TABLE(name text, expires_at timestamptz)
    LANGUAGE sql STABLE ${definer} AS $$
      SELECT p.name, p.expires_at FROM bridge_pairings p WHERE p.user_code = code AND p.approved_at IS NULL AND p.expires_at > now()
    $$`.execute(db);
  await sql`CREATE FUNCTION bridge_pairing_approve(code text, account uuid, bridge text, sealed text) RETURNS boolean
    LANGUAGE sql VOLATILE ${definer} AS $$
      WITH done AS (
        UPDATE bridge_pairings SET account_id = account, bridge_id = bridge, token_sealed = sealed, approved_at = now()
        WHERE user_code = code AND approved_at IS NULL AND expires_at > now() RETURNING 1
      ) SELECT EXISTS (SELECT FROM done)
    $$`.execute(db);
  // The box polls: waiting, expired, or (once) its token.
  await sql`CREATE FUNCTION bridge_pairing_take(device_hash text) RETURNS TABLE(status text, bridge_id text, token_sealed text)
    LANGUAGE plpgsql VOLATILE ${definer} AS $$
    DECLARE p bridge_pairings%ROWTYPE;
    BEGIN
      SELECT * INTO p FROM bridge_pairings WHERE device_code_hash = device_hash FOR UPDATE;
      IF NOT FOUND THEN RETURN QUERY SELECT 'unknown'::text, NULL::text, NULL::text; RETURN; END IF;
      IF p.taken_at IS NOT NULL THEN RETURN QUERY SELECT 'taken'::text, p.bridge_id, NULL::text; RETURN; END IF;
      IF p.approved_at IS NULL THEN
        IF p.expires_at <= now() THEN RETURN QUERY SELECT 'expired'::text, NULL::text, NULL::text; RETURN; END IF;
        RETURN QUERY SELECT 'waiting'::text, NULL::text, NULL::text; RETURN;
      END IF;
      UPDATE bridge_pairings SET taken_at = now(), token_sealed = NULL WHERE id = p.id;
      RETURN QUERY SELECT 'approved'::text, p.bridge_id, p.token_sealed;
    END $$`.execute(db);
  for (const f of FUNCTIONS) await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      ${sql.raw(FUNCTIONS.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO senseplane_app;`).join("\n      "))}
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const f of FUNCTIONS) await sql.raw(`DROP FUNCTION ${f}`).execute(db);
  await db.schema.dropTable("bridge_pairings").execute();
}
