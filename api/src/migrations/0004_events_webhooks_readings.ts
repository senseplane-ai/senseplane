// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

async function isolate(db: Kysely<unknown>, table: string) {
  await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON ${sql.table(table)}
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("sources")
    .addColumn("zones", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("privacy_masks", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("sensor_thresholds", "jsonb")
    .execute();

  await db.schema
    .createTable("events")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("source_id", "text", (c) => c.notNull())
    .addColumn("event_key", "text", (c) => c.notNull())
    .addColumn("type", "text", (c) => c.notNull())
    .addColumn("watch_id", "text")
    .addColumn("sense", "text", (c) => c.notNull())
    .addColumn("occurred_at", "timestamptz", (c) => c.notNull())
    .addColumn("ended_at", "timestamptz")
    .addColumn("summary", "text", (c) => c.notNull())
    .addColumn("labels", sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'`))
    .addColumn("zones", sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'`))
    .addColumn("confidence", "real")
    .addColumn("value", "jsonb")
    .addColumn("snapshot_key", "text")
    .addColumn("clip_id", "text")
    .addColumn("clip_due_at", "timestamptz")
    .addColumn("feedback", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("events_key_unique", ["account_id", "event_key"])
    .execute();
  await db.schema.createIndex("events_source_time_idx").on("events").columns(["source_id", "occurred_at"]).execute();
  await db.schema.createIndex("events_account_time_idx").on("events").columns(["account_id", "occurred_at"]).execute();
  await isolate(db, "events");

  await db.schema
    .createTable("webhooks")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("url", "text", (c) => c.notNull())
    .addColumn("events", sql`text[]`, (c) => c.notNull())
    .addColumn("secret", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await isolate(db, "webhooks");

  await db.schema
    .createTable("webhook_deliveries")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull())
    .addColumn("webhook_id", "text", (c) => c.notNull().references("webhooks.id").onDelete("cascade"))
    .addColumn("event_id", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("pending"))
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("next_attempt_at", "timestamptz", (c) => c.defaultTo(sql`now()`))
    .addColumn("last_status_code", "integer")
    .addColumn("last_error", "text")
    .addColumn("delivered_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("deliveries_due_idx").on("webhook_deliveries").columns(["status", "next_attempt_at"]).execute();
  await db.schema.createIndex("deliveries_webhook_idx").on("webhook_deliveries").columns(["webhook_id", "created_at"]).execute();
  await isolate(db, "webhook_deliveries");

  // Sensor readings: natively partitioned by month (ADR 0005), BRIN on time.
  await sql`CREATE TABLE sensor_readings (
    account_id uuid NOT NULL, source_id text NOT NULL, sense text NOT NULL,
    value double precision NOT NULL, unit text NOT NULL, measured_at timestamptz NOT NULL
  ) PARTITION BY RANGE (measured_at)`.execute(db);
  await sql`CREATE TABLE sensor_readings_default PARTITION OF sensor_readings DEFAULT`.execute(db);
  await sql`CREATE INDEX sensor_readings_source_time ON sensor_readings (source_id, measured_at)`.execute(db);
  await sql`CREATE INDEX sensor_readings_time_brin ON sensor_readings USING brin (measured_at)`.execute(db);
  await isolate(db, "sensor_readings");
  await isolate(db, "sensor_readings_default");
  // Creates the monthly partition for a timestamp when missing (called by the API before inserts).
  await sql`CREATE FUNCTION ensure_readings_partition(ts timestamptz) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE start date := date_trunc('month', ts); name text := 'sensor_readings_' || to_char(ts, 'YYYYMM');
    BEGIN
      IF to_regclass(name) IS NULL THEN
        EXECUTE format('CREATE TABLE %I PARTITION OF sensor_readings FOR VALUES FROM (%L) TO (%L)', name, start, start + interval '1 month');
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', name);
        EXECUTE format('CREATE POLICY account_isolation ON %I USING (account_id = nullif(current_setting(''app.account_id'', true), '''')::uuid) WITH CHECK (account_id = nullif(current_setting(''app.account_id'', true), '''')::uuid)', name);
        EXECUTE format('GRANT SELECT, INSERT, DELETE ON %I TO senseplane_app', name);
      END IF;
    END $$`.execute(db);

  // Webhook worker: which deliveries are due, across accounts (ids only).
  await sql`CREATE FUNCTION due_webhook_deliveries(max_rows integer) RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT id, account_id FROM webhook_deliveries
      WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT max_rows
    $$`.execute(db);
  // Event clip worker: events whose clip window has passed, across accounts (ids only).
  await sql`CREATE FUNCTION due_event_clips(max_rows integer) RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT id, account_id FROM events WHERE clip_id IS NULL AND clip_due_at IS NOT NULL AND clip_due_at <= now()
      ORDER BY clip_due_at LIMIT max_rows
    $$`.execute(db);
  for (const f of ["ensure_readings_partition(timestamptz)", "due_webhook_deliveries(integer)", "due_event_clips(integer)"]) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
  }

  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON events, webhooks, webhook_deliveries TO senseplane_app;
      GRANT SELECT, INSERT, DELETE ON sensor_readings, sensor_readings_default TO senseplane_app;
      GRANT EXECUTE ON FUNCTION ensure_readings_partition(timestamptz), due_webhook_deliveries(integer), due_event_clips(integer) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const f of ["due_event_clips(integer)", "due_webhook_deliveries(integer)", "ensure_readings_partition(timestamptz)"]) await sql.raw(`DROP FUNCTION ${f}`).execute(db);
  await sql`DROP TABLE sensor_readings`.execute(db);
  for (const t of ["webhook_deliveries", "webhooks", "events"]) await db.schema.dropTable(t).execute();
  await db.schema.alterTable("sources").dropColumn("zones").dropColumn("privacy_masks").dropColumn("sensor_thresholds").execute();
}
