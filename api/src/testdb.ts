// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Test helper: creates a throwaway database, migrates it as the owner role and
// returns a runtime URL for the non-superuser app role (so RLS applies).
import pg from "pg";
import { migrateToLatest } from "./migrate.js";

const ADMIN = process.env.TEST_ADMIN_DATABASE_URL ?? "postgres://senseplane:senseplane@localhost:55432/senseplane";
const APP_USER = process.env.TEST_APP_USER ?? "senseplane_app:senseplane_app";

export async function createTestDatabase(): Promise<{ appUrl: string; drop: () => Promise<void> }> {
  const name = `sp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const ownerUrl = new URL(ADMIN);
  ownerUrl.pathname = `/${name}`;
  await migrateToLatest(ownerUrl.toString());

  const appUrl = new URL(ownerUrl);
  const [user, password] = APP_USER.split(":");
  appUrl.username = user!;
  appUrl.password = password!;

  return {
    appUrl: appUrl.toString(),
    drop: async () => {
      const c = new pg.Client({ connectionString: ADMIN });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
