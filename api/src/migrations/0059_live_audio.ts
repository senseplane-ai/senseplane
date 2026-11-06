// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Whether sound is arriving with a source's live stream: set from the media plane's
// source.online codecs, cleared when it goes offline (null: not known). Listen uses it
// to say "no sound is arriving" instead of "no sounds detected" for a silent stream.
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sources").addColumn("live_audio", "boolean").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sources").dropColumn("live_audio").execute();
}
