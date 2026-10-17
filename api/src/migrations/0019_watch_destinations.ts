// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Watch destinations (ADR 0043): where a watch's events go (`notify`), when it
// is active (`active_hours`, in a time zone), and an inbox per agent for the
// events routed to it (read through MCP `what_happened` or GET /v1/inbox).
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // Empty notify = default routing (every webhook subscribed to the event type).
  await db.schema.alterTable("watches")
    .addColumn("notify", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("active_hours", "jsonb")
    .execute();

  await db.schema.createTable("agent_inbox")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("agent_id", "text", (c) => c.notNull().references("agents.id").onDelete("cascade"))
    .addColumn("event_id", "text", (c) => c.notNull().references("events.id").onDelete("cascade"))
    .addColumn("watch_id", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("seen_at", "timestamptz")
    .addUniqueConstraint("agent_inbox_agent_event", ["agent_id", "event_id"])
    .execute();
  await sql`CREATE INDEX agent_inbox_unseen ON agent_inbox (account_id, agent_id, id) WHERE seen_at IS NULL`.execute(db);
  await sql`ALTER TABLE agent_inbox ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE agent_inbox FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON agent_inbox
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON agent_inbox TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("agent_inbox").execute();
  await db.schema.alterTable("watches").dropColumn("notify").dropColumn("active_hours").execute();
}
