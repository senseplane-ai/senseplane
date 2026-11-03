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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sources").dropColumn("talk").execute();
}
