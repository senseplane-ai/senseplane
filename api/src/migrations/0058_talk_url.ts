// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Talk-back through go2rtc's two-way audio sources (ADR 0075): a bridge camera's
// speaker may be reached by another URL than its RTSP backchannel (tapo://,
// isapi://, dvrip://...). It carries credentials, so it is stored encrypted, as
// rtsp_url is, and only ever sent to the camera's bridge.
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sources").addColumn("talk_url", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sources").dropColumn("talk_url").execute();
}
