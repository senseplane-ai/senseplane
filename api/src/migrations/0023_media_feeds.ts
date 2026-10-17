// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The media contract (ADR 0049): one row per camera for its feed egress
// session on the media plane (segments + frames). The API starts it at token
// time and stops it when the camera has been offline for a while, is paused
// or deleted, or is out of allowance. The owner-defined functions let the
// sweeper find feeds and live viewers across accounts, and let a bridge's
// per-camera WHIP bearer be checked against the bridge's current token.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("media_feeds")
    .addColumn("source_id", "text", (c) => c.primaryKey().references("sources.id").onDelete("cascade"))
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("session_id", "text", (c) => c.notNull())
    .addColumn("started_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("stopped_at", "timestamptz")
    .addColumn("stop_reason", "text")
    .execute();
  await sql`ALTER TABLE media_feeds ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE media_feeds FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON media_feeds
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);

  // Running feeds whose camera is paused, or has not been online for `seconds`.
  await sql`CREATE FUNCTION feeds_to_stop(seconds integer) RETURNS TABLE(account_id uuid, source_id text, session_id text, reason text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT f.account_id, f.source_id, f.session_id, CASE WHEN s.status = 'paused' THEN 'paused' ELSE 'offline' END
      FROM media_feeds f JOIN sources s ON s.id = f.source_id
      WHERE f.stopped_at IS NULL AND (
        s.status = 'paused'
        OR (s.status <> 'online' AND coalesce(s.status_since, f.started_at) < now() - make_interval(secs => seconds)
            AND f.started_at < now() - make_interval(secs => seconds))
      )
      LIMIT 500
    $$`.execute(db);
  // Live viewers still open, with their camera's state (idle close, camera offline, metering).
  await sql`CREATE FUNCTION open_live_sessions() RETURNS TABLE(account_id uuid, id text, source_id text, joined_at timestamptz,
      last_seen_at timestamptz, source_status text, source_status_since timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT l.account_id, l.id, l.source_id, l.joined_at, l.last_seen_at, s.status, s.status_since
      FROM live_sessions l JOIN sources s ON s.id = l.source_id
      WHERE l.ended_at IS NULL AND l.joined_at IS NOT NULL
      LIMIT 5000
    $$`.execute(db);
  // A bridge's camera WHIP bearer names the bridge and a prefix of its token's hash: rotating the token retires them.
  await sql`CREATE FUNCTION auth_bridge_whip(bridge text, hash_prefix text) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT b.account_id FROM bridges b JOIN accounts a ON a.id = b.account_id
      WHERE b.id = bridge AND b.revoked_at IS NULL AND a.deleted_at IS NULL AND length(hash_prefix) >= 16 AND left(b.token_hash, length(hash_prefix)) = hash_prefix
    $$`.execute(db);
  for (const f of ["feeds_to_stop(integer)", "open_live_sessions()", "auth_bridge_whip(text, text)"]) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
  }
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON media_feeds TO senseplane_app;
      GRANT EXECUTE ON FUNCTION feeds_to_stop(integer), open_live_sessions(), auth_bridge_whip(text, text) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const f of ["auth_bridge_whip(text, text)", "open_live_sessions()", "feeds_to_stop(integer)"]) await sql.raw(`DROP FUNCTION ${f}`).execute(db);
  await db.schema.dropTable("media_feeds").execute();
}
