// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Multi-camera stories (ADR 0070): one video from many moments across
// cameras, in time order. A story is a list of pieces (a camera and a time
// range); a background job renders it (or copies the segments untouched, in
// fast mode) into story segments under stories/, kept like a saved clip.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("stories")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("title", "text")
    .addColumn("mode", "text", (c) => c.notNull().check(sql`mode IN ('labelled', 'fast')`))
    .addColumn("status", "text", (c) => c.notNull().defaultTo("queued").check(sql`status IN ('queued', 'rendering', 'ready', 'failed')`))
    .addColumn("error", "text")
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("created_by_agent", "text")
    .addColumn("duration_ms", "integer")
    .addColumn("bytes", "bigint", (c) => c.notNull().defaultTo(0))
    .addColumn("has_audio", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("due_at", "timestamptz", (c) => c.defaultTo(sql`now()`))
    .addColumn("claimed_until", "timestamptz")
    .addColumn("claim_token", "text")
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("ready_at", "timestamptz")
    .execute();
  await db.schema.createIndex("stories_due").on("stories").column("due_at").where(sql.ref("due_at"), "is not", null).execute();

  // What the story shows, in order: the camera's name as labelled, the range, and whether its audio was granted.
  await db.schema
    .createTable("story_pieces")
    .addColumn("story_id", "text", (c) => c.notNull().references("stories.id").onDelete("cascade"))
    .addColumn("seq", "integer", (c) => c.notNull())
    .addColumn("account_id", "uuid", (c) => c.notNull())
    .addColumn("source_id", "text", (c) => c.notNull())
    .addColumn("source_name", "text", (c) => c.notNull())
    .addColumn("from_at", "timestamptz", (c) => c.notNull())
    .addColumn("to_at", "timestamptz", (c) => c.notNull())
    .addColumn("event_id", "text")
    .addColumn("audio", "boolean", (c) => c.notNull().defaultTo(false))
    // Filled in by the render: how much was recorded, and where the piece starts in the story.
    .addColumn("recorded_ms", "integer")
    .addColumn("offset_ms", "integer")
    .addPrimaryKeyConstraint("story_pieces_pk", ["story_id", "seq"])
    .execute();

  // The story's own segments: copies (fast mode, same ciphertext as the recording, keyed by its camera)
  // or rendered and encrypted with a key of the story's own (ADR 0066). key_source names which.
  await db.schema
    .createTable("story_segments")
    .addColumn("story_id", "text", (c) => c.notNull().references("stories.id").onDelete("cascade"))
    .addColumn("seq", "integer", (c) => c.notNull())
    .addColumn("account_id", "uuid", (c) => c.notNull())
    .addColumn("piece", "integer")
    .addColumn("key", "text", (c) => c.notNull())
    .addColumn("init_key", "text", (c) => c.notNull())
    .addColumn("start_at", "timestamptz", (c) => c.notNull())
    .addColumn("duration_ms", "integer", (c) => c.notNull())
    .addColumn("key_source", "text", (c) => c.notNull())
    .addColumn("strip_audio", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("enc_version", "integer")
    .addColumn("enc_iv", "bytea")
    .addPrimaryKeyConstraint("story_segments_pk", ["story_id", "seq"])
    .execute();

  for (const table of ["stories", "story_pieces", "story_segments"]) {
    await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`.execute(db);
    await sql`CREATE POLICY account_isolation ON ${sql.table(table)}
      USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  }

  // Claimed with a lease and a token (ADR 0058): only the current claimant may write the outcome or delete
  // objects; the worker renews the lease while it works. After max_attempts claims a job fails for good.
  await sql`CREATE FUNCTION claim_stories(max_rows integer, lease_s integer, max_attempts integer) RETURNS TABLE(id text, account_id uuid, token text)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
    #variable_conflict use_column
    BEGIN
      UPDATE stories SET status = 'failed', error = 'the story could not be made', due_at = NULL, claimed_until = NULL, claim_token = NULL
        WHERE due_at IS NOT NULL AND attempts >= max_attempts AND (claimed_until IS NULL OR claimed_until < now());
      RETURN QUERY
        UPDATE stories t SET claimed_until = now() + make_interval(secs => lease_s), attempts = t.attempts + 1, status = 'rendering',
          claim_token = gen_random_uuid()::text
        WHERE t.id IN (
          SELECT d.id FROM stories d
          WHERE d.due_at IS NOT NULL AND d.due_at <= now() AND (d.claimed_until IS NULL OR d.claimed_until < now()) AND d.attempts < max_attempts
          ORDER BY d.due_at LIMIT max_rows
          FOR UPDATE SKIP LOCKED)
        RETURNING t.id, t.account_id, t.claim_token;
    END $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION claim_stories(integer, integer, integer) FROM PUBLIC`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON stories, story_pieces, story_segments TO senseplane_app;
      GRANT EXECUTE ON FUNCTION claim_stories(integer, integer, integer) TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION claim_stories(integer, integer, integer)`.execute(db);
  await db.schema.dropTable("story_segments").execute();
  await db.schema.dropTable("story_pieces").execute();
  await db.schema.dropTable("stories").execute();
}
