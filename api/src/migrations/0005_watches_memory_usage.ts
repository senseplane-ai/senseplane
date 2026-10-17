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
    .createTable("watches")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("instruction", "text", (c) => c.notNull())
    .addColumn("sources", sql`text[]`, (c) => c.notNull())
    .addColumn("mode", "text", (c) => c.notNull().defaultTo("alert"))
    .addColumn("compiled", "jsonb", (c) => c.notNull())
    .addColumn("estimate", "jsonb", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("active"))
    .addColumn("warnings", sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'`))
    .addColumn("compiler", "text", (c) => c.notNull().defaultTo("rules"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await isolate(db, "watches");

  // Memory: one embedding per event (all-MiniLM-L6-v2, 384 dims, cosine).
  await sql`ALTER TABLE events ADD COLUMN embedding vector(384)`.execute(db);
  await sql`CREATE INDEX events_embedding_idx ON events USING hnsw (embedding vector_cosine_ops)`.execute(db);

  // Usage records (the meters are built from these): vlm_calls, llm_calls, frames_analysed, …
  await db.schema
    .createTable("usage_records")
    .addColumn("id", "bigserial", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull())
    .addColumn("source_id", "text")
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("quantity", "bigint", (c) => c.notNull())
    .addColumn("at", "timestamptz", (c) => c.notNull())
    .execute();
  await db.schema.createIndex("usage_account_kind_at").on("usage_records").columns(["account_id", "kind", "at"]).execute();
  await isolate(db, "usage_records");

  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON watches, usage_records TO senseplane_app;
      GRANT USAGE ON SEQUENCE usage_records_id_seq TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("usage_records").execute();
  await sql`ALTER TABLE events DROP COLUMN embedding`.execute(db);
  await db.schema.dropTable("watches").execute();
}
