// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Talk-back (ADR 0069). A camera has a speaker or not: a phone on the capture
// page always does, an IP camera when its box found two-way audio. Everything
// said through a camera is a speak message, kept with who said it, through
// what, the text (agents and watches), how long it was and what happened; an
// agent's or a watch's clip is kept sealed in storage so a person can hear
// exactly what was said. A watch's message is queued here and claimed by one
// API process (ADR 0058).
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;
const FUNCTIONS = ["claim_speak_messages(integer, integer)"];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sources").addColumn("speaker", "boolean", (c) => c.notNull().defaultTo(false)).execute();
  await sql`UPDATE sources SET speaker = true WHERE type = 'browser'`.execute(db);

  await db.schema
    .createTable("speak_messages")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    // No foreign key to the source: the record outlives the camera, like the audit log.
    .addColumn("source_id", "text", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind IN ('agent', 'watch', 'person')`))
    // Who: user:<id>, owner:<key prefix> or agent:<id>, with a name to show, and through what.
    .addColumn("actor", "text", (c) => c.notNull())
    .addColumn("actor_kind", "text", (c) => c.notNull())
    .addColumn("actor_name", "text")
    .addColumn("via", "text", (c) => c.notNull())
    .addColumn("agent_id", "text")
    .addColumn("watch_id", "text")
    .addColumn("event_id", "text")
    .addColumn("live_session_id", "text")
    .addColumn("text", "text")
    .addColumn("status", "text", (c) => c.notNull().check(sql`status IN ('queued', 'sent', 'playing', 'played', 'interrupted', 'refused', 'offline', 'late', 'failed')`))
    .addColumn("message", "text")
    .addColumn("duration_ms", "integer")
    .addColumn("clip_key", "text")
    .addColumn("clip_bytes", "integer")
    .addColumn("bridge_command_id", "text")
    // A message plays until then (one speaker at a time); a person's push-to-talk ends it early.
    .addColumn("ends_at", "timestamptz")
    .addColumn("claimed_until", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("finished_at", "timestamptz")
    .execute();
  await db.schema.createIndex("speak_messages_source").on("speak_messages").columns(["source_id", "created_at"]).execute();
  await db.schema.createIndex("speak_messages_queued").on("speak_messages").columns(["status", "created_at"]).where(sql.ref("status"), "=", "queued").execute();
  await db.schema.createIndex("speak_messages_bridge_command").on("speak_messages").column("bridge_command_id").execute();
  await sql`ALTER TABLE speak_messages ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE speak_messages FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON speak_messages
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);

  // Watch messages waiting to be said, across accounts, each claimed by one process for a lease.
  await sql`CREATE FUNCTION claim_speak_messages(max_rows integer, lease_s integer) RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      UPDATE speak_messages m SET claimed_until = now() + make_interval(secs => lease_s)
      WHERE m.id IN (
        SELECT d.id FROM speak_messages d
        WHERE d.status = 'queued' AND (d.claimed_until IS NULL OR d.claimed_until < now())
        ORDER BY d.created_at LIMIT max_rows FOR UPDATE SKIP LOCKED)
      RETURNING m.id, m.account_id
    $$`.execute(db);
  for (const f of FUNCTIONS) await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON speak_messages TO senseplane_app;
      ${sql.raw(FUNCTIONS.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO senseplane_app;`).join("\n      "))}
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const f of FUNCTIONS) await sql.raw(`DROP FUNCTION ${f}`).execute(db);
  await db.schema.dropTable("speak_messages").execute();
  await db.schema.alterTable("sources").dropColumn("speaker").execute();
}
