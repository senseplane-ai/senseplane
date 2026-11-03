// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Workflows (ADR 0072): a trigger (an event, a schedule or a signed webhook)
// and a graph of steps that tell people and systems, ask the vision model,
// speak, save clips and stories, and wait. Never a step that switches a
// device. Runs are rows claimed by one API process with a lease and a claim
// token (ADR 0058); each run keeps the definition it follows and a row per
// step it reached, with its status, timing, output and error.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;
const FUNCTIONS = [
  "claim_workflow_runs(integer, integer, timestamptz)",
  "claim_workflow_schedules(integer, integer, timestamptz)",
  "workflow_hook(text)",
  "prune_workflow_runs(integer)",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("workflows")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("enabled", "boolean", (c) => c.notNull().defaultTo(true))
    // { trigger, steps, edges }, checked against spec/schemas/workflow.json and as a DAG on every write.
    .addColumn("definition", "jsonb", (c) => c.notNull())
    .addColumn("trigger_type", "text", (c) => c.notNull().check(sql`trigger_type IN ('event', 'schedule', 'webhook')`))
    .addColumn("source_ids", sql`text[]`, (c) => c.notNull())
    // The webhook trigger's signing secret, sealed like webhook secrets (ADR 0027); shown once.
    .addColumn("hook_secret", "text")
    // Schedules: when it is next due, and the scheduler's lease on it.
    .addColumn("next_fire_at", "timestamptz")
    .addColumn("fire_claimed_until", "timestamptz")
    .addColumn("last_fired_at", "timestamptz")
    .addColumn("runs_dropped", "integer", (c) => c.notNull().defaultTo(0))
    // Webhook requests whose signature didn't verify: counted, and audited at most once a minute (no body kept).
    .addColumn("hook_failures", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("last_hook_failure_at", "timestamptz")
    .addColumn("last_run_at", "timestamptz")
    .addColumn("created_by", "text", (c) => c.notNull())
    .addColumn("updated_by", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("workflows_account").on("workflows").columns(["account_id", "trigger_type"]).where(sql.ref("enabled"), "=", true).execute();
  await db.schema.createIndex("workflows_next_fire").on("workflows").column("next_fire_at").where(sql.ref("next_fire_at"), "is not", null).execute();

  await db.schema
    .createTable("workflow_runs")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    // A deleted workflow's runs stay (cancelled, said why) until they are pruned.
    .addColumn("workflow_id", "text", (c) => c.references("workflows.id").onDelete("set null"))
    // What this run follows, as it was when it started: edits never change a run under way.
    .addColumn("definition", "jsonb", (c) => c.notNull())
    .addColumn("source_ids", sql`text[]`, (c) => c.notNull())
    .addColumn("workflow_name", "text", (c) => c.notNull())
    // What started it: { type, event_id?, input?, scheduled_for?, by? }.
    .addColumn("trigger", "jsonb", (c) => c.notNull())
    .addColumn("event_id", "text")
    .addColumn("status", "text", (c) => c.notNull().defaultTo("queued").check(sql`status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')`))
    .addColumn("error", "text")
    .addColumn("failed_step", "text")
    .addColumn("due_at", "timestamptz", (c) => c.defaultTo(sql`now()`))
    .addColumn("claimed_until", "timestamptz")
    .addColumn("claim_token", "text")
    // Times another process took the run over from one whose lease ran out (not resumes after a wait).
    .addColumn("claims", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .execute();
  await db.schema.createIndex("workflow_runs_due").on("workflow_runs").column("due_at").where(sql.ref("due_at"), "is not", null).execute();
  await db.schema.createIndex("workflow_runs_workflow").on("workflow_runs").columns(["workflow_id", "created_at"]).execute();
  await db.schema.createIndex("workflow_runs_account").on("workflow_runs").columns(["account_id", "created_at"]).execute();

  await db.schema
    .createTable("workflow_run_steps")
    .addColumn("run_id", "text", (c) => c.notNull().references("workflow_runs.id").onDelete("cascade"))
    .addColumn("step_id", "text", (c) => c.notNull())
    .addColumn("account_id", "uuid", (c) => c.notNull())
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().check(sql`status IN ('running', 'waiting', 'succeeded', 'failed', 'skipped')`))
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
    // A waiting step (wait, or a clip waiting for its recording): when it may go on.
    .addColumn("resume_at", "timestamptz")
    .addColumn("output", "jsonb")
    .addColumn("error", "text")
    .addColumn("started_at", "timestamptz")
    .addColumn("finished_at", "timestamptz")
    .addPrimaryKeyConstraint("workflow_run_steps_pk", ["run_id", "step_id"])
    .execute();

  // Signatures the webhook trigger has taken, to refuse a replay (as for the readings webhook, ADR 0071).
  await db.schema
    .createTable("workflow_hook_signatures")
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("workflow_id", "text", (c) => c.notNull().references("workflows.id").onDelete("cascade"))
    .addColumn("mac", "text", (c) => c.notNull())
    .addColumn("signed_at", "bigint", (c) => c.notNull())
    .addPrimaryKeyConstraint("workflow_hook_signatures_pk", ["workflow_id", "mac"])
    .execute();

  for (const table of ["workflows", "workflow_runs", "workflow_run_steps", "workflow_hook_signatures"]) {
    await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
    await sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`.execute(db);
    await sql`CREATE POLICY account_isolation ON ${sql.table(table)}
      USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  }

  // A workflow speaks as itself (ADR 0069, 0072).
  await sql`ALTER TABLE speak_messages DROP CONSTRAINT speak_messages_kind_check`.execute(db);
  await sql`ALTER TABLE speak_messages ADD CONSTRAINT speak_messages_kind_check CHECK (kind IN ('agent', 'watch', 'person', 'workflow'))`.execute(db);

  // Runs that are due, claimed with a lease and a fresh token; only the token's holder writes the run's steps.
  await sql`CREATE FUNCTION claim_workflow_runs(max_rows integer, lease_s integer, at timestamptz DEFAULT now())
    RETURNS TABLE(id text, account_id uuid, token text)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      UPDATE workflow_runs r SET claimed_until = at + make_interval(secs => lease_s), claim_token = gen_random_uuid()::text,
        claims = r.claims + CASE WHEN r.claimed_until IS NOT NULL THEN 1 ELSE 0 END, status = 'running', started_at = coalesce(r.started_at, at)
      WHERE r.id IN (
        SELECT d.id FROM workflow_runs d JOIN accounts a ON a.id = d.account_id
        WHERE d.due_at IS NOT NULL AND d.due_at <= at AND (d.claimed_until IS NULL OR d.claimed_until < at) AND a.deleted_at IS NULL
        ORDER BY d.due_at LIMIT max_rows
        FOR UPDATE OF d SKIP LOCKED)
      RETURNING r.id, r.account_id, r.claim_token
    $$`.execute(db);
  // Scheduled workflows that are due, with a lease while the run is queued and the next time worked out.
  await sql`CREATE FUNCTION claim_workflow_schedules(max_rows integer, lease_s integer, at timestamptz DEFAULT now())
    RETURNS TABLE(account_id uuid, id text)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      UPDATE workflows w SET fire_claimed_until = at + make_interval(secs => lease_s)
      WHERE w.id IN (
        SELECT d.id FROM workflows d JOIN accounts a ON a.id = d.account_id
        WHERE d.next_fire_at IS NOT NULL AND d.next_fire_at <= at AND d.enabled AND a.deleted_at IS NULL
          AND (d.fire_claimed_until IS NULL OR d.fire_claimed_until < at)
        ORDER BY d.next_fire_at LIMIT max_rows
        FOR UPDATE OF d SKIP LOCKED)
      RETURNING w.account_id, w.id
    $$`.execute(db);
  // The webhook trigger has no API key: the workflow's id finds its account, and the signature is checked against its secret.
  await sql`CREATE FUNCTION workflow_hook(workflow text) RETURNS TABLE(account_id uuid, hook_secret text, enabled boolean, trigger_type text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT w.account_id, w.hook_secret, w.enabled, w.trigger_type FROM workflows w JOIN accounts a ON a.id = w.account_id
      WHERE w.id = workflow AND a.deleted_at IS NULL
    $$`.execute(db);
  // Finished runs go after the days given (30), or sooner: never kept longer than the shortest retention of
  // their cameras and sensors (or the account's), since a step's output and a webhook's input describe footage.
  await sql`CREATE FUNCTION prune_workflow_runs(days integer) RETURNS integer
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      WITH keep AS (
        SELECT r.id, least(days, coalesce((SELECT min(coalesce(s.retention_days, a.retention_days, days)) FROM sources s WHERE s.id = ANY(r.source_ids)),
          a.retention_days, days)) AS d
        FROM workflow_runs r JOIN accounts a ON a.id = r.account_id
        WHERE r.due_at IS NULL
      ), gone AS (
        DELETE FROM workflow_runs w USING keep k WHERE w.id = k.id AND w.created_at < now() - make_interval(days => k.d) RETURNING 1
      )
      SELECT count(*)::integer FROM gone
    $$`.execute(db);
  // When the event that started a run, or one of its sources, is deleted, what the run kept about it goes too:
  // step outputs and the webhook's input. The run's statuses and errors stay.
  await sql`CREATE FUNCTION workflow_runs_forget() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public SET row_security = off AS $$
    BEGIN
      IF TG_TABLE_NAME = 'events' THEN
        UPDATE workflow_run_steps SET output = NULL WHERE run_id IN (SELECT id FROM workflow_runs WHERE account_id = OLD.account_id AND event_id = OLD.id);
        UPDATE workflow_runs SET trigger = trigger - 'input' WHERE account_id = OLD.account_id AND event_id = OLD.id;
      ELSE
        UPDATE workflow_run_steps SET output = NULL WHERE run_id IN (SELECT id FROM workflow_runs WHERE account_id = OLD.account_id AND OLD.id = ANY(source_ids));
        UPDATE workflow_runs SET trigger = trigger - 'input' WHERE account_id = OLD.account_id AND OLD.id = ANY(source_ids);
      END IF;
      RETURN OLD;
    END $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION workflow_runs_forget() FROM PUBLIC`.execute(db);
  await sql`CREATE TRIGGER workflow_runs_forget_event AFTER DELETE ON events FOR EACH ROW EXECUTE FUNCTION workflow_runs_forget()`.execute(db);
  await sql`CREATE TRIGGER workflow_runs_forget_source AFTER DELETE ON sources FOR EACH ROW EXECUTE FUNCTION workflow_runs_forget()`.execute(db);

  for (const f of FUNCTIONS) await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON workflows, workflow_runs, workflow_run_steps, workflow_hook_signatures TO senseplane_app;
      ${sql.raw(FUNCTIONS.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO senseplane_app;`).join("\n      "))}
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER workflow_runs_forget_event ON events`.execute(db);
  await sql`DROP TRIGGER workflow_runs_forget_source ON sources`.execute(db);
  await sql`DROP FUNCTION workflow_runs_forget()`.execute(db);
  for (const f of FUNCTIONS) await sql.raw(`DROP FUNCTION ${f}`).execute(db);
  await sql`DELETE FROM speak_messages WHERE kind = 'workflow'`.execute(db);
  await sql`ALTER TABLE speak_messages DROP CONSTRAINT speak_messages_kind_check`.execute(db);
  await sql`ALTER TABLE speak_messages ADD CONSTRAINT speak_messages_kind_check CHECK (kind IN ('agent', 'watch', 'person'))`.execute(db);
  await db.schema.dropTable("workflow_hook_signatures").execute();
  await db.schema.dropTable("workflow_run_steps").execute();
  await db.schema.dropTable("workflow_runs").execute();
  await db.schema.dropTable("workflows").execute();
}
