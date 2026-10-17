// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { Migrator } from "kysely/migration";
import { createDb } from "./data/db.js";
import { migrationProvider } from "./migrations/index.js";

/** Runs all pending migrations as the owner role (MIGRATION_DATABASE_URL). */
export async function migrateToLatest(url: string): Promise<void> {
  const db = createDb(url, 1);
  try {
    const { error, results } = await new Migrator({ db, provider: migrationProvider }).migrateToLatest();
    for (const r of results ?? []) {
      console.log(JSON.stringify({ level: "info", msg: "migration", name: r.migrationName, status: r.status }));
    }
    if (error) throw error;
  } finally {
    await db.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
  await migrateToLatest(url);
}
