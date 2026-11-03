// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Device commands (ADR 0067), tightened: the agent a request came through
// (a Telegram chat's agent, for a person asking in their own chat) and that
// chat, so an approval can check the agent still has its Control grant; and a
// sweep for commands a box took and never reported, so nothing waits forever.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("device_commands").addColumn("agent_id", "text").addColumn("channel_id", "text").execute();
  await sql`UPDATE device_commands SET agent_id = substr(actor, 7) WHERE actor LIKE 'agent:%'`.execute(db);
  // Device commands sent to a box more than `seconds` ago with no report (ids only), for the periodic sweep.
  await sql`CREATE FUNCTION stuck_device_commands(seconds integer) RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT d.id, d.account_id FROM device_commands d WHERE d.status = 'sent' AND d.created_at < now() - make_interval(secs => seconds)
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION stuck_device_commands(integer) FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT EXECUTE ON FUNCTION stuck_device_commands(integer) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS stuck_device_commands(integer)`.execute(db);
  await db.schema.alterTable("device_commands").dropColumn("agent_id").dropColumn("channel_id").execute();
}
