// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Background work shared by any number of API processes (ADR 0058). Each due
// row is claimed by one process with FOR UPDATE SKIP LOCKED and a lease, so a
// crashed process's work is picked up when its lease runs out:
//   - scheduled_jobs: housekeeping, one row per job, run once per interval;
//   - watches.next_check_at: condition and digest watches, by when each is due;
//   - webhook deliveries and event clips, by when each is due.
// The owner-defined functions claim across accounts; `at` stands in for now()
// in tests.
import { type Kysely, sql } from "kysely";

const FUNCTIONS = [
  "claim_jobs(text[], text, timestamptz)",
  "finish_job(text, text, text, jsonb, timestamptz)",
  "renew_job(text, text, integer)",
  "claim_scheduled_watches(integer, integer, timestamptz)",
  "claim_webhook_deliveries(integer, integer)",
  "claim_event_clips(integer, integer)",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("scheduled_jobs")
    .addColumn("name", "text", (c) => c.primaryKey())
    .addColumn("every_s", "integer", (c) => c.notNull())
    .addColumn("lease_s", "integer", (c) => c.notNull())
    .addColumn("next_run_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("claimed_until", "timestamptz")
    .addColumn("claimed_by", "text")
    .addColumn("last_started_at", "timestamptz")
    .addColumn("last_finished_at", "timestamptz")
    .addColumn("last_error", "text")
    .addColumn("state", "jsonb")
    .execute();

  // Claims the named jobs that are due, for each job's lease. Jobs are "name:every_s:lease_s"; new ones are registered.
  await sql`CREATE FUNCTION claim_jobs(jobs text[], worker text, at timestamptz DEFAULT now())
    RETURNS TABLE(name text, state jsonb)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
    #variable_conflict use_column
    BEGIN
      INSERT INTO scheduled_jobs (name, every_s, lease_s, next_run_at)
        SELECT split_part(j, ':', 1), split_part(j, ':', 2)::integer, split_part(j, ':', 3)::integer, at FROM unnest(jobs) j
        ON CONFLICT ON CONSTRAINT scheduled_jobs_pkey DO UPDATE SET every_s = excluded.every_s, lease_s = excluded.lease_s
        WHERE (scheduled_jobs.every_s, scheduled_jobs.lease_s) IS DISTINCT FROM (excluded.every_s, excluded.lease_s);
      RETURN QUERY
        UPDATE scheduled_jobs s SET claimed_until = at + make_interval(secs => s.lease_s), claimed_by = worker, last_started_at = at
        WHERE s.name IN (
          SELECT d.name FROM scheduled_jobs d
          WHERE d.name IN (SELECT split_part(j, ':', 1) FROM unnest(jobs) j) AND d.next_run_at <= at AND (d.claimed_until IS NULL OR d.claimed_until < at)
          FOR UPDATE SKIP LOCKED)
        RETURNING s.name, s.state;
    END $$`.execute(db);
  // Ends a claimed run: the next run is a full interval later; state is kept for the next run.
  await sql`CREATE FUNCTION finish_job(job text, worker text, error text, new_state jsonb, at timestamptz DEFAULT now()) RETURNS void
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
      UPDATE scheduled_jobs SET next_run_at = at + make_interval(secs => every_s), claimed_until = NULL, claimed_by = NULL,
        last_finished_at = at, last_error = error, state = coalesce(new_state, state)
      WHERE name = job AND claimed_by = worker
    $$`.execute(db);
  // Keeps a long-running claim (the Telegram poller); false when another worker has taken it.
  await sql`CREATE FUNCTION renew_job(job text, worker text, lease_s integer) RETURNS boolean
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
      WITH r AS (UPDATE scheduled_jobs SET claimed_until = now() + make_interval(secs => lease_s)
        WHERE name = job AND claimed_by = worker AND claimed_until >= now() RETURNING 1)
      SELECT EXISTS (SELECT FROM r)
    $$`.execute(db);

  // Condition and digest watches: when each is next due. A new, edited or resumed one is due at once ('epoch');
  // the checker sets the exact next time after each check, and anything else clears it.
  await db.schema.alterTable("watches")
    .addColumn("next_check_at", "timestamptz")
    .addColumn("claimed_until", "timestamptz")
    .execute();
  await sql`CREATE FUNCTION watches_next_check() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status = 'active' AND NEW.compiled->'trigger'->>'type' IN ('condition', 'digest') THEN
        IF TG_OP = 'INSERT' OR NEW.compiled IS DISTINCT FROM OLD.compiled OR NEW.active_hours IS DISTINCT FROM OLD.active_hours
          OR OLD.status IS DISTINCT FROM 'active' OR NEW.next_check_at IS NULL THEN
          NEW.next_check_at := 'epoch';
        END IF;
      ELSE
        NEW.next_check_at := NULL;
      END IF;
      RETURN NEW;
    END $$`.execute(db);
  await sql`CREATE TRIGGER watches_next_check BEFORE INSERT OR UPDATE OF status, compiled, active_hours ON watches
    FOR EACH ROW EXECUTE FUNCTION watches_next_check()`.execute(db);
  await sql`UPDATE watches SET next_check_at = 'epoch' WHERE status = 'active' AND compiled->'trigger'->>'type' IN ('condition', 'digest')`.execute(db);
  await sql`CREATE INDEX watches_next_check ON watches (next_check_at) WHERE next_check_at IS NOT NULL`.execute(db);
  await sql`DROP FUNCTION scheduled_watches()`.execute(db);
  await sql`CREATE FUNCTION claim_scheduled_watches(max_rows integer, lease_s integer, at timestamptz DEFAULT now())
    RETURNS TABLE(account_id uuid, id text)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      UPDATE watches w SET claimed_until = at + make_interval(secs => lease_s)
      WHERE w.id IN (
        SELECT d.id FROM watches d JOIN accounts a ON a.id = d.account_id
        WHERE d.next_check_at <= at AND (d.claimed_until IS NULL OR d.claimed_until < at)
          AND a.deleted_at IS NULL AND (d.expires_at IS NULL OR d.expires_at > at)
        ORDER BY d.next_check_at LIMIT max_rows
        FOR UPDATE OF d SKIP LOCKED)
      RETURNING w.account_id, w.id
    $$`.execute(db);

  // Webhook deliveries and event clips: claimed with a lease instead of read by everyone.
  await db.schema.alterTable("webhook_deliveries").addColumn("claimed_until", "timestamptz").execute();
  await sql`DROP FUNCTION due_webhook_deliveries(integer)`.execute(db);
  await sql`CREATE FUNCTION claim_webhook_deliveries(max_rows integer, lease_s integer) RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      UPDATE webhook_deliveries w SET claimed_until = now() + make_interval(secs => lease_s)
      WHERE w.id IN (
        SELECT d.id FROM webhook_deliveries d
        WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND (d.claimed_until IS NULL OR d.claimed_until < now())
        ORDER BY d.next_attempt_at LIMIT max_rows
        FOR UPDATE SKIP LOCKED)
      RETURNING w.id, w.account_id
    $$`.execute(db);
  await db.schema.alterTable("events").addColumn("clip_claimed_until", "timestamptz").execute();
  await sql`DROP FUNCTION due_event_clips(integer)`.execute(db);
  await sql`CREATE FUNCTION claim_event_clips(max_rows integer, lease_s integer) RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      UPDATE events e SET clip_claimed_until = now() + make_interval(secs => lease_s)
      WHERE e.id IN (
        SELECT d.id FROM events d
        WHERE d.clip_id IS NULL AND d.clip_due_at IS NOT NULL AND d.clip_due_at <= now()
          AND (d.clip_claimed_until IS NULL OR d.clip_claimed_until < now())
        ORDER BY d.clip_due_at LIMIT max_rows
        FOR UPDATE SKIP LOCKED)
      RETURNING e.id, e.account_id
    $$`.execute(db);

  for (const f of FUNCTIONS) await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      ${sql.raw(FUNCTIONS.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO senseplane_app;`).join("\n      "))}
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const f of FUNCTIONS) await sql.raw(`DROP FUNCTION ${f}`).execute(db);
  await sql`CREATE FUNCTION due_webhook_deliveries(max_rows integer) RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT id, account_id FROM webhook_deliveries
      WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT max_rows
    $$`.execute(db);
  await sql`CREATE FUNCTION due_event_clips(max_rows integer) RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT id, account_id FROM events WHERE clip_id IS NULL AND clip_due_at IS NOT NULL AND clip_due_at <= now()
      ORDER BY clip_due_at LIMIT max_rows
    $$`.execute(db);
  await sql`CREATE FUNCTION scheduled_watches() RETURNS TABLE(account_id uuid, id text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT w.account_id, w.id FROM watches w JOIN accounts a ON a.id = w.account_id
      WHERE w.status = 'active' AND a.deleted_at IS NULL AND w.compiled->'trigger'->>'type' IN ('condition', 'digest')
        AND (w.expires_at IS NULL OR w.expires_at > now())
      LIMIT 5000
    $$`.execute(db);
  for (const f of ["due_webhook_deliveries(integer)", "due_event_clips(integer)", "scheduled_watches()"]) {
    await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
    await sql.raw(`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN GRANT EXECUTE ON FUNCTION ${f} TO senseplane_app; END IF; END $$`).execute(db);
  }
  await db.schema.alterTable("events").dropColumn("clip_claimed_until").execute();
  await db.schema.alterTable("webhook_deliveries").dropColumn("claimed_until").execute();
  await sql`DROP TRIGGER watches_next_check ON watches`.execute(db);
  await sql`DROP FUNCTION watches_next_check()`.execute(db);
  await db.schema.alterTable("watches").dropColumn("claimed_until").dropColumn("next_check_at").execute();
  await db.schema.dropTable("scheduled_jobs").execute();
}
