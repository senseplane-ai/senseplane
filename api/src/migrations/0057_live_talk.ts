// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Push-to-talk to IP cameras (ADR 0074): whether a camera's box can carry a
// person's live voice to its speaker, as the box reports it. A phone on the
// capture page always can when it has a speaker.
import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sources").addColumn("talk", "boolean", (c) => c.notNull().defaultTo(false)).execute();
  await sql`UPDATE sources SET talk = speaker WHERE type = 'browser'`.execute(db);
  // Each press is its own track on the media plane: its row is keyed on it, so retried and out-of-order
  // callbacks land on the right press. heard_ms is how long the camera's speaker carried it (a box's report).
  await db.schema.alterTable("speak_messages").addColumn("producer_id", "text").addColumn("heard_ms", "integer").execute();
  await sql`CREATE UNIQUE INDEX speak_messages_producer ON speak_messages (source_id, producer_id) WHERE producer_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS speak_messages_producer`.execute(db);
  await db.schema.alterTable("speak_messages").dropColumn("producer_id").dropColumn("heard_ms").execute();
  await db.schema.alterTable("sources").dropColumn("talk").execute();
}
