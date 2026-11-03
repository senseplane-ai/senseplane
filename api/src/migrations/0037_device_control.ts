// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Control, only when a person asks (ADR 0067). A box's entities become
// devices: each gets an id, the actions the box can run on it, and a switch an
// admin turns on to make it controllable (off by default). Every request to
// switch one is a device command, kept with who asked, through what, the
// outcome and the state read back; a request waiting for a person to confirm
// is one too. Work handed to a box can expire, so a command the box didn't take
// in time is never run later.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("bridge_entities")
    .addColumn("id", "text")
    .addColumn("controls", sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn("controllable", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("controllable_by", "text")
    .addColumn("controllable_at", "timestamptz")
    .execute();
  await sql`UPDATE bridge_entities SET id = 'dev_' || substr(md5(bridge_id || ':' || entity_id), 1, 20)`.execute(db);
  await sql`ALTER TABLE bridge_entities ALTER COLUMN id SET DEFAULT 'dev_' || substr(md5(random()::text || clock_timestamp()::text), 1, 20)`.execute(db);
  await sql`ALTER TABLE bridge_entities ALTER COLUMN id SET NOT NULL`.execute(db);
  await db.schema.createIndex("bridge_entities_id").on("bridge_entities").column("id").unique().execute();

  // A command a box didn't take by expires_at is never handed out (no queueing).
  await db.schema.alterTable("bridge_commands").addColumn("expires_at", "timestamptz").execute();
  await sql`ALTER TABLE bridge_commands DROP CONSTRAINT IF EXISTS bridge_commands_status_check`.execute(db);
  await sql`ALTER TABLE bridge_commands ADD CONSTRAINT bridge_commands_status_check CHECK (status IN ('pending', 'taken', 'done', 'failed', 'expired'))`.execute(db);

  await db.schema
    .createTable("device_commands")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    // No foreign keys to the device or the box: the record outlives both.
    .addColumn("device_id", "text", (c) => c.notNull())
    .addColumn("bridge_id", "text", (c) => c.notNull())
    .addColumn("entity_id", "text", (c) => c.notNull())
    .addColumn("device_name", "text", (c) => c.notNull())
    .addColumn("action", "text", (c) => c.notNull())
    .addColumn("value", "jsonb")
    .addColumn("tier", "text", (c) => c.notNull())
    // Who asked: user:<id>, owner:<key prefix> or agent:<id>, with a name to show, and through what.
    .addColumn("actor", "text", (c) => c.notNull())
    .addColumn("actor_kind", "text", (c) => c.notNull())
    .addColumn("actor_name", "text")
    .addColumn("via", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().check(sql`status IN ('awaiting_confirmation', 'denied', 'expired', 'refused', 'sent', 'done', 'in_progress', 'unchanged', 'offline', 'failed')`))
    .addColumn("message", "text")
    .addColumn("state_after", "jsonb")
    .addColumn("bridge_command_id", "text")
    .addColumn("expires_at", "timestamptz")
    .addColumn("decided_by", "text")
    .addColumn("decided_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("finished_at", "timestamptz")
    .execute();
  await db.schema.createIndex("device_commands_device").on("device_commands").columns(["device_id", "created_at"]).execute();
  await db.schema.createIndex("device_commands_waiting").on("device_commands").columns(["status", "expires_at"]).execute();
  await db.schema.createIndex("device_commands_bridge_command").on("device_commands").column("bridge_command_id").execute();
  await sql`ALTER TABLE device_commands ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE device_commands FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON device_commands
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON device_commands TO senseplane_app;
    END IF;
  END $$`.execute(db);
  // Requests nobody confirmed in time (ids only), for the API's periodic sweep that refuses them.
  await sql`CREATE FUNCTION expired_confirmations() RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT d.id, d.account_id FROM device_commands d WHERE d.status = 'awaiting_confirmation' AND d.expires_at < now()
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION expired_confirmations() FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT EXECUTE ON FUNCTION expired_confirmations() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS expired_confirmations()`.execute(db);
  await db.schema.dropTable("device_commands").execute();
  await sql`UPDATE bridge_commands SET status = 'failed' WHERE status = 'expired'`.execute(db);
  await sql`ALTER TABLE bridge_commands DROP CONSTRAINT IF EXISTS bridge_commands_status_check`.execute(db);
  await sql`ALTER TABLE bridge_commands ADD CONSTRAINT bridge_commands_status_check CHECK (status IN ('pending', 'taken', 'done', 'failed'))`.execute(db);
  await db.schema.alterTable("bridge_commands").dropColumn("expires_at").execute();
  await db.schema.dropIndex("bridge_entities_id").execute();
  await db.schema.alterTable("bridge_entities").dropColumn("id").dropColumn("controls").dropColumn("controllable").dropColumn("controllable_by").dropColumn("controllable_at").execute();
}
