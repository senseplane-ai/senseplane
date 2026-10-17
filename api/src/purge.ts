// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Deletes an account and everything it owns: objects first, then rows.
import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";
import type { DataAccess } from "./data/access.js";
import type { ApiBus } from "./indexer.js";
import type { ObjectStorage } from "./storage.js";

type Deps = { data: DataAccess; bus?: ApiBus; storage?: ObjectStorage };

/** Returns the model calls the account had made (kept by callers that need totals). */
export async function deleteAccountData(deps: Deps, accountId: string): Promise<number> {
  const { watches, sources } = await deps.data.withAccount(accountId, async (a) => ({
    watches: await a.db.selectFrom("watches").select("id").execute(),
    sources: await a.db.selectFrom("sources").select("id").execute(),
  }));
  for (const w of watches) await deps.bus?.putWatch(accountId, w.id, null).catch(() => undefined);
  for (const s of sources) await deps.bus?.putSourceConfig(accountId, s.id, {}).catch(() => undefined);
  for (const prefix of ["raw", "clips", "snapshots", "exports"]) await deps.storage?.deletePrefix(`${prefix}/${accountId}/`);
  return deps.data.withAccount(accountId, async (a) => {
    const r = await a.db.selectFrom("usage_records").select(sql<string>`coalesce(sum(quantity), 0)`.as("n")).where("kind", "=", "vlm_calls").executeTakeFirst();
    await a.db.deleteFrom("usage_records").execute(); // no FK to accounts
    await a.db.deleteFrom("sensor_readings").execute(); // no FK to accounts
    // Cascades to sources, segments, events, clips, watches, webhooks, deliveries, keys, agents, grants, audit.
    await a.db.deleteFrom("accounts").where("id", "=", accountId).execute();
    return Number(r?.n ?? 0);
  });
}

/** Accounts deleted with DELETE /v1/account: gone at the next sweep (well within 24 h). */
export async function purgeDeletedAccounts(deps: Deps, log?: FastifyBaseLogger) {
  const ids = (await sql<{ id: string }>`select * from accounts_to_delete()`.execute(deps.data.db())).rows;
  for (const { id } of ids) {
    await deleteAccountData(deps, id);
    log?.info({ account: id }, "account deleted");
  }
  return ids.length;
}
