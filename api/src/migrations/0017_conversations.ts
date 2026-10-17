// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Conversations (Ask, ADR 0041): chats about what the sources saw and heard.
// Moments are stored as references (event id, or a snapshot key for a live
// look), never as signed links: links are signed when a message is read.
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
    .createTable("conversations")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    // The agent whose key started it; null for account keys. An agent key sees only its own.
    .addColumn("agent_id", "text", (c) => c.references("agents.id").onDelete("cascade"))
    .addColumn("title", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await db.schema.createIndex("conversations_recent").on("conversations").columns(["account_id", "updated_at"]).execute();
  await isolate(db, "conversations");

  await db.schema
    .createTable("messages")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("conversation_id", "text", (c) => c.notNull().references("conversations.id").onDelete("cascade"))
    .addColumn("role", "text", (c) => c.notNull().check(sql`role in ('user', 'assistant')`))
    .addColumn("content", "text", (c) => c.notNull())
    .addColumn("moments", "jsonb", (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn("suggested_watch", "jsonb")
    // The reader's thumbs on an assistant answer (helpful | not_helpful), null until given.
    .addColumn("feedback", "text", (c) => c.check(sql`feedback in ('helpful', 'not_helpful')`))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`clock_timestamp()`))
    .execute();
  await db.schema.createIndex("messages_conversation").on("messages").columns(["conversation_id", "created_at"]).execute();
  await isolate(db, "messages");

  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON conversations, messages TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("messages").execute();
  await db.schema.dropTable("conversations").execute();
}
