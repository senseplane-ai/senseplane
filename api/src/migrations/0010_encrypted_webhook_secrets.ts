// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { type Kysely, sql } from "kysely";

// Webhook secrets are encrypted at rest (ADR 0027). The rows themselves are
// re-encrypted by the API at startup, because the key never reaches the
// database; this function lets it find the accounts that still hold plain ones.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE FUNCTION accounts_with_plain_webhook_secrets() RETURNS TABLE(account_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
      SELECT DISTINCT w.account_id FROM webhooks w WHERE w.secret NOT LIKE 'enc:v1:%'
    $$`.execute(db);
  await sql`REVOKE ALL ON FUNCTION accounts_with_plain_webhook_secrets() FROM PUBLIC`.execute(db);
  await sql`ALTER FUNCTION accounts_with_plain_webhook_secrets() SET row_security = off`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT EXECUTE ON FUNCTION accounts_with_plain_webhook_secrets() TO senseplane_app;
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS accounts_with_plain_webhook_secrets()`.execute(db);
}
