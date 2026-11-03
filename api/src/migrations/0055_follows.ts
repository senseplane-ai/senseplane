// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Following an object or a pet across cameras (ADR 0070): "how did this box
// move through the house?". A follow names a reference (a box on an event
// snapshot or a recorded frame, or a description) and a time range; a
// background job looks for it in the recordings and stores the route it
// found. Never a person: the API and the brain refuse one, and nothing
// about the reference (no crop, no embedding) is stored.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("follows")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("status", "text", (c) => c.notNull().defaultTo("queued").check(sql`status IN ('queued', 'running', 'done', 'failed', 'refused')`))
    .addColumn("error", "text")
    // Where the reference is: { event_id | source_id + at, box } and/or { description }. No pixels.
    .addColumn("reference", "jsonb", (c) => c.notNull())
    .addColumn("source_ids", sql`text[]`, (c) => c.notNull())
    .addColumn("from_at", "timestamptz", (c) => c.notNull())
    .addColumn("to_at", "timestamptz", (c) => c.notNull())
    .addColumn("make_story", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("story_id", "text")
    // The route: sightings per camera in time order, handovers and gaps, with what it cost.
    .addColumn("result", "jsonb")
    .addColumn("frames_examined", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("model_calls", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_by_agent", "text")
    .addColumn("due_at", "timestamptz", (c) => c.defaultTo(sql`now()`))
    .addColumn("claimed_until", "timestamptz")
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("finished_at", "timestamptz")
    .execute();
  await db.schema.createIndex("follows_due").on("follows").column("due_at").where(sql.ref("due_at"), "is not", null).execute();
  await sql`ALTER TABLE follows ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE follows FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON follows
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);

  await sql`CREATE FUNCTION claim_follows(max_rows integer, lease_s integer) RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      UPDATE follows t SET claimed_until = now() + make_interval(secs => lease_s), attempts = t.attempts + 1, status = 'running'
      WHERE t.id IN (
        SELECT d.id FROM follows d
        WHERE d.due_at IS NOT NULL AND d.due_at <= now() AND (d.claimed_until IS NULL OR d.claimed_until < now())
        ORDER BY d.due_at LIMIT max_rows
        FOR UPDATE SKIP LOCKED)
      RETURNING t.id, t.account_id
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION claim_follows(integer, integer) FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON follows TO senseplane_app;
      GRANT EXECUTE ON FUNCTION claim_follows(integer, integer) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION claim_follows(integer, integer)`.execute(db);
  await db.schema.dropTable("follows").execute();
}
