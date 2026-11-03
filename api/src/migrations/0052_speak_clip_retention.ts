// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// What agents and watches said through cameras is personal data (ADR 0069):
// its clips go after the camera's retention days. A camera kept by size
// (fill mode) uses the account's days instead, and with no days at all a clip
// is kept 7 days. A camera that no longer exists takes its clips with it.
// Every camera counts, whether or not it records footage or sound.
import { type Kysely, sql } from "kysely";

const FN = "speak_clips_due(integer)";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION speak_clips_due(max_rows integer) RETURNS TABLE(id text, account_id uuid, clip_key text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT m.id, m.account_id, m.clip_key
      FROM speak_messages m
      JOIN accounts a ON a.id = m.account_id
      LEFT JOIN sources s ON s.id = m.source_id AND s.account_id = m.account_id
      WHERE m.clip_key IS NOT NULL AND (
        s.id IS NULL
        OR m.created_at < now() - make_interval(days => coalesce(
          CASE WHEN coalesce(s.retention_mode, a.retention_mode) = 'days' THEN coalesce(s.retention_days, a.retention_days) ELSE a.retention_days END,
          7)))
      ORDER BY m.created_at
      LIMIT max_rows
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
}
