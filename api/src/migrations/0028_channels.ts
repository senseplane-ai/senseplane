// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Channels (ADR 0059): chats in a messaging app (Telegram first) that a
// watch's events go to and that can ask questions. A channel is linked with a
// one-time code, asks as an agent of kind `channel` (its grants apply), and
// sends through an outbox claimed like webhook deliveries (ADR 0058), at most
// one message per chat at a time and spaced to the app's per-chat limits.
// Incoming updates are stored once by id and handled by whichever process
// claims them. The owner-defined functions work across accounts: a chat id or
// a link code doesn't say which account it belongs to.
import { type Kysely, sql } from "kysely";

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.account_id', true), '')::uuid`;

const FUNCTIONS = [
  "redeem_channel_link(text)",
  "chat_channels(text, text)",
  "claim_channel_messages(integer, integer)",
  "store_telegram_update(bigint, jsonb)",
  "claim_telegram_updates(integer, integer)",
  "finish_telegram_update(bigint)",
];

async function isolate(db: Kysely<unknown>, table: string) {
  await sql`ALTER TABLE ${sql.table(table)} ENABLE ROW LEVEL SECURITY`.execute(db);
  await sql`ALTER TABLE ${sql.table(table)} FORCE ROW LEVEL SECURITY`.execute(db);
  await sql`CREATE POLICY account_isolation ON ${sql.table(table)}
    USING (account_id = ${CURRENT_ACCOUNT}) WITH CHECK (account_id = ${CURRENT_ACCOUNT})`.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("channels")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("kind", "text", (c) => c.notNull().check(sql`kind IN ('telegram')`))
    .addColumn("chat_id", "text", (c) => c.notNull())
    .addColumn("chat_type", "text", (c) => c.notNull())
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("active").check(sql`status IN ('active', 'blocked', 'unlinked')`))
    // The agent it asks as (kind 'channel'), and that agent's key, encrypted.
    .addColumn("agent_id", "text", (c) => c.notNull().references("agents.id"))
    .addColumn("agent_key", "text", (c) => c.notNull())
    .addColumn("snapshots", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("can_ask", "boolean", (c) => c.notNull().defaultTo(true))
    .addColumn("muted_until", "timestamptz")
    // A chat linked to several workspaces asks the one chosen last (/use).
    .addColumn("selected_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("conversation_id", "text")
    .addColumn("conversation_at", "timestamptz")
    // Per-chat spacing for the outbox.
    .addColumn("next_send_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("linked_by", "text")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE UNIQUE INDEX channels_chat ON channels (account_id, kind, chat_id) WHERE status = 'active'`.execute(db);
  await sql`CREATE INDEX channels_by_chat ON channels (kind, chat_id) WHERE status = 'active'`.execute(db);
  await isolate(db, "channels");

  await db.schema
    .createTable("channel_links")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("kind", "text", (c) => c.notNull())
    .addColumn("code_hash", "text", (c) => c.notNull().unique())
    .addColumn("created_by", "text")
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("used_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await isolate(db, "channel_links");

  await db.schema
    .createTable("channel_messages")
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("account_id", "uuid", (c) => c.notNull().references("accounts.id").onDelete("cascade"))
    .addColumn("channel_id", "text", (c) => c.notNull().references("channels.id").onDelete("cascade"))
    .addColumn("event_id", "text")
    // What to send when there is no event: {text, buttons?, photo_key?} (answers, notices).
    .addColumn("body", "jsonb")
    .addColumn("status", "text", (c) => c.notNull().defaultTo("pending").check(sql`status IN ('pending', 'sent', 'failed', 'skipped')`))
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("next_attempt_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("claimed_until", "timestamptz")
    .addColumn("last_error", "text")
    .addColumn("sent_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX channel_messages_due ON channel_messages (next_attempt_at) WHERE status = 'pending'`.execute(db);
  await sql`CREATE INDEX channel_messages_channel ON channel_messages (channel_id, created_at)`.execute(db);
  await isolate(db, "channel_messages");

  // Updates from Telegram (webhook or polling), once each by update id; not an account's until handled.
  await db.schema
    .createTable("telegram_updates")
    .addColumn("update_id", "bigint", (c) => c.primaryKey())
    .addColumn("body", "jsonb", (c) => c.notNull())
    .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
    .addColumn("claimed_until", "timestamptz")
    .addColumn("processed_at", "timestamptz")
    .addColumn("received_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .execute();
  await sql`CREATE INDEX telegram_updates_due ON telegram_updates (update_id) WHERE processed_at IS NULL`.execute(db);

  await sql`ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_kind_check`.execute(db);

  // A link code (hashed) for the account it was made in; once, before it expires.
  await sql`CREATE FUNCTION redeem_channel_link(hash text) RETURNS TABLE(account_id uuid, kind text, created_by text)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      UPDATE channel_links SET used_at = now()
      WHERE code_hash = hash AND used_at IS NULL AND expires_at > now()
      RETURNING channel_links.account_id, channel_links.kind, channel_links.created_by
    $$`.execute(db);
  // The active channels for a chat, in every account, the chosen one first.
  await sql`CREATE FUNCTION chat_channels(chat_kind text, chat text) RETURNS TABLE(account_id uuid, id text, account_name text)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      SELECT c.account_id, c.id, a.name FROM channels c JOIN accounts a ON a.id = c.account_id
      WHERE c.kind = chat_kind AND c.chat_id = chat AND c.status = 'active' AND a.deleted_at IS NULL
      ORDER BY c.selected_at DESC, c.created_at DESC
    $$`.execute(db);
  // Due messages, at most one per chat (the oldest) and only for chats whose spacing allows it.
  await sql`CREATE FUNCTION claim_channel_messages(max_rows integer, lease_s integer) RETURNS TABLE(id text, account_id uuid)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public SET row_security = off AS $$
      WITH due AS (
        SELECT DISTINCT ON (m.channel_id) m.id
        FROM channel_messages m JOIN channels c ON c.id = m.channel_id
        WHERE m.status = 'pending' AND m.next_attempt_at <= now() AND (m.claimed_until IS NULL OR m.claimed_until < now()) AND c.next_send_at <= now()
          AND NOT EXISTS (SELECT FROM channel_messages o WHERE o.channel_id = m.channel_id AND o.status = 'pending' AND o.claimed_until >= now())
        ORDER BY m.channel_id, m.created_at
      )
      UPDATE channel_messages w SET claimed_until = now() + make_interval(secs => lease_s)
      WHERE w.id IN (SELECT d.id FROM channel_messages d WHERE d.id IN (SELECT id FROM due) ORDER BY d.next_attempt_at LIMIT max_rows FOR UPDATE SKIP LOCKED)
      RETURNING w.id, w.account_id
    $$`.execute(db);
  await sql`CREATE FUNCTION store_telegram_update(uid bigint, ubody jsonb) RETURNS boolean
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
      WITH ins AS (INSERT INTO telegram_updates (update_id, body) VALUES (uid, ubody) ON CONFLICT (update_id) DO NOTHING RETURNING 1)
      SELECT EXISTS (SELECT FROM ins)
    $$`.execute(db);
  await sql`CREATE FUNCTION claim_telegram_updates(max_rows integer, lease_s integer) RETURNS TABLE(update_id bigint, body jsonb)
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
      UPDATE telegram_updates u SET claimed_until = now() + make_interval(secs => lease_s), attempts = u.attempts + 1
      WHERE u.update_id IN (
        SELECT d.update_id FROM telegram_updates d
        WHERE d.processed_at IS NULL AND (d.claimed_until IS NULL OR d.claimed_until < now()) AND d.attempts < 5
        ORDER BY d.update_id LIMIT max_rows FOR UPDATE SKIP LOCKED)
      RETURNING u.update_id, u.body
    $$`.execute(db);
  // Handled updates are kept a day (so a retried webhook isn't handled twice), then removed.
  await sql`CREATE FUNCTION finish_telegram_update(uid bigint) RETURNS void
    LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
      UPDATE telegram_updates SET processed_at = now(), claimed_until = NULL WHERE update_id = uid;
      DELETE FROM telegram_updates WHERE received_at < now() - interval '1 day';
    $$`.execute(db);

  for (const f of FUNCTIONS) await sql.raw(`REVOKE ALL ON FUNCTION ${f} FROM PUBLIC`).execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON channels, channel_links, channel_messages TO senseplane_app;
      ${sql.raw(FUNCTIONS.map((f) => `GRANT EXECUTE ON FUNCTION ${f} TO senseplane_app;`).join("\n      "))}
    END IF;
  END $$`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const f of FUNCTIONS) await sql.raw(`DROP FUNCTION ${f}`).execute(db);
  await db.schema.dropTable("telegram_updates").execute();
  await db.schema.dropTable("channel_messages").execute();
  await db.schema.dropTable("channel_links").execute();
  await db.schema.dropTable("channels").execute();
}
