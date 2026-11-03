// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Privacy blurring (ADR 0068): blur faces and blur number plates, per account
// (off by default) and per source (null follows the account).
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("accounts")
    .addColumn("blur_faces", "boolean", (c) => c.notNull().defaultTo(false))
    .addColumn("blur_plates", "boolean", (c) => c.notNull().defaultTo(false))
    .execute();
  await db.schema.alterTable("sources").addColumn("blur_faces", "boolean").addColumn("blur_plates", "boolean").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("sources").dropColumn("blur_faces").dropColumn("blur_plates").execute();
  await db.schema.alterTable("accounts").dropColumn("blur_faces").dropColumn("blur_plates").execute();
}
