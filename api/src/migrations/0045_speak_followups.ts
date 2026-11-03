// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Talk-back (ADR 0069), the rest: a message that cost a speech call counts
// against the camera's rate whatever happened next, and box messages that
// never got a report can be found and given up.
import { type Kysely, sql } from "kysely";

const FN = "lost_speak_messages(integer)";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("speak_messages").addColumn("tts_used", "boolean", (c) => c.notNull().defaultTo(false)).execute();
  await sql`UPDATE speak_messages SET tts_used = true WHERE clip_key IS NOT NULL OR duration_ms IS NOT NULL`.execute(db);
  // Messages handed to a box that it never reported, this long after they should have finished.
  await sql`CREATE FUNCTION lost_speak_messages(after_s integer) RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT m.id, m.account_id FROM speak_messages m
      WHERE m.status = 'sent' AND m.bridge_command_id IS NOT NULL AND m.ends_at < now() - make_interval(secs => after_s)
    $$`.execute(db);
  await sql.raw(`REVOKE ALL ON FUNCTION ${FN} FROM PUBLIC`).execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      ${sql.raw(`GRANT EXECUTE ON FUNCTION ${FN} TO senseplane_app;`)}
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql.raw(`DROP FUNCTION ${FN}`).execute(db);
  await db.schema.alterTable("speak_messages").dropColumn("tts_used").execute();
}
