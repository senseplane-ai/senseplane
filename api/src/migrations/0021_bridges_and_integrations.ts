// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Bridges, RTSP cameras and sensor integration tokens (ADR 0045).
// - `bridges`: one row per bridge device, authenticated by a hashed bearer
//   token; several `rtsp` sources can hang off one bridge.
// - sources gain the bridge they belong to, their RTSP URL (encrypted with
//   SECRETS_ENCRYPTION_KEY, ADR 0027), the state the bridge last reported and
//   `status_since`, kept by a trigger whenever `status` changes.
// - Sensor integration tokens reuse `ingest_tokens` (per source, hashed).
// - Readings retention follows the account's (or source's) retention days.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("bridges")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("token_hash", "text", (c) => c.notNull().unique())
    .addColumn("prefix", "text", (c) => c.notNull())
    .addColumn("version", "text")
    .addColumn("last_seen_at", "timestamptz")
    .addColumn("revoked_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`ALTER TABLE bridges ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE bridges FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON bridges
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);

  await db.schema
    .alterTable("sources")
    .addColumn("bridge_id", "text", (c) => c.references("bridges.id").onDelete("set null"))
    .addColumn("rtsp_url", "text")
    .addColumn("bridge_state", "text")
    .addColumn("bridge_detail", "text")
    .addColumn("status_since", "timestamptz")
    .execute();
  await db.schema.createIndex("sources_bridge").on("sources").column("bridge_id").execute();
  await sql`UPDATE sources SET status_since = created_at`.execute(db);
  await sql`CREATE FUNCTION sources_status_since() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN NEW.status_since := now(); END IF;
      RETURN NEW;
    END $$`.execute(db);
  await sql`CREATE TRIGGER sources_status_since BEFORE INSERT OR UPDATE OF status ON sources
    FOR EACH ROW EXECUTE FUNCTION sources_status_since()`.execute(db);

  // Bridge token → (bridge, account), before the account is known.
  await sql`CREATE FUNCTION auth_bridge_token(hash text) RETURNS TABLE(bridge_id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT b.id, b.account_id FROM bridges b JOIN accounts a ON a.id = b.account_id
      WHERE b.token_hash = hash AND b.revoked_at IS NULL AND a.deleted_at IS NULL
    $$`.execute(db);
  // Sensor integration token → (source, account); the token names its source.
  await sql`CREATE FUNCTION auth_integration_token(hash text) RETURNS TABLE(source_id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT t.source_id, t.account_id FROM ingest_tokens t
        JOIN accounts a ON a.id = t.account_id
        JOIN sources s ON s.id = t.source_id AND s.account_id = t.account_id
      WHERE t.token_hash = hash AND t.revoked_at IS NULL AND a.deleted_at IS NULL AND s.type = 'sensor'
    $$`.execute(db);
  // Bridges that stopped reporting (ids only), for the API's periodic sweep.
  await sql`CREATE FUNCTION silent_bridges(seconds integer) RETURNS TABLE(bridge_id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT b.id, b.account_id FROM bridges b
      WHERE b.last_seen_at < now() - make_interval(secs => seconds)
        AND EXISTS (SELECT 1 FROM sources s WHERE s.bridge_id = b.id AND s.bridge_state IS DISTINCT FROM 'offline')
    $$`.execute(db);
  await sql`CREATE FUNCTION readings_retention_targets() RETURNS TABLE(account_id uuid, source_id text, retention_days integer)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT s.account_id, s.id, coalesce(s.retention_days, a.retention_days)
      FROM sources s JOIN accounts a ON a.id = s.account_id
      WHERE s.type = 'sensor' AND coalesce(s.retention_days, a.retention_days) IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM sensor_readings r
          WHERE r.source_id = s.id AND r.measured_at < now() - make_interval(days => coalesce(s.retention_days, a.retention_days))
        )
    $$`.execute(db);
  for (const f of ["auth_bridge_token(text)", "auth_integration_token(text)", "silent_bridges(integer)", "readings_retention_targets()"]) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
  }
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON bridges TO senseplane_app;
      GRANT EXECUTE ON FUNCTION auth_bridge_token(text), auth_integration_token(text), silent_bridges(integer), readings_retention_targets() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const f of ["readings_retention_targets()", "silent_bridges(integer)", "auth_integration_token(text)", "auth_bridge_token(text)"]) {
    await sql.raw(`DROP FUNCTION ${f}`).execute(db);
  }
  await sql`DROP TRIGGER sources_status_since ON sources`.execute(db);
  await sql`DROP FUNCTION sources_status_since()`.execute(db);
  await db.schema.alterTable("sources")
    .dropColumn("bridge_id").dropColumn("rtsp_url").dropColumn("bridge_state").dropColumn("bridge_detail").dropColumn("status_since")
    .execute();
  await db.schema.dropTable("bridges").execute();
}
