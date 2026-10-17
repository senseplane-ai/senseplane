// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { type Kysely, type Selectable, type Transaction, sql } from "kysely";
import type { Database, Role, SegmentsTable, SourcesTable } from "./schema.js";
import { newId } from "./ids.js";
import type { SecretBox } from "../secret-box.js";

export type Source = Selectable<SourcesTable>;
export type Segment = Selectable<SegmentsTable>;

export interface NewSegment {
  source_id: string;
  key: string;
  init_key: string;
  start_at: string;
  duration_ms: number;
  bytes: number;
  codec: string;
  has_audio: boolean;
}

/** Who is behind an API key. `userId`/`role` are set for console sessions only. */
export interface Principal {
  accountId: string;
  agentId: string | null;
  userId: string | null;
  role: Role | null;
}

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** Queries available inside one account's transaction. RLS limits every row to that account. */
export class AccountScope {
  constructor(
    readonly accountId: string,
    /** Raw Kysely transaction for modules that need more than the helpers below. */
    readonly db: Transaction<Database>,
  ) {}

  readonly account = {
    get: () => this.db.selectFrom("accounts").selectAll().where("id", "=", this.accountId).executeTakeFirst(),
  };

  readonly sources = {
    list: (): Promise<Source[]> => this.db.selectFrom("sources").selectAll().orderBy("id").execute(),
    get: (id: string): Promise<Source | undefined> =>
      this.db.selectFrom("sources").selectAll().where("id", "=", id).executeTakeFirst(),
    create: (input: {
      name: string;
      type: string;
      location?: string | null;
      senses?: string[];
      record_audio?: boolean;
      retention_days?: number | null;
    }): Promise<Source> =>
      this.db
        .insertInto("sources")
        .values({
          id: newId("src"),
          account_id: this.accountId,
          name: input.name,
          type: input.type,
          location: input.location ?? null,
          senses: input.senses ?? ["video"],
          record_audio: input.record_audio ?? false,
          retention_days: input.retention_days ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    /**
     * Media plane online/offline. A bridge camera whose bridge is reconnecting shows `reconnecting`, not offline (ADR 0045);
     * a paused camera stays paused (its last session ending must not undo the pause).
     */
    setStatus: (id: string, status: "online" | "offline", at?: Date) => {
      let q = this.db.updateTable("sources")
        .set({ status: status === "online" ? "online" : sql<string>`case when bridge_state = 'reconnecting' then 'reconnecting' else 'offline' end` })
        .where("id", "=", id).where("status", "!=", "paused");
      // An event from before the last change (a late retry) does not undo it.
      if (at) q = q.where((eb) => eb.or([eb("status_since", "is", null), eb("status_since", "<=", at)]));
      return q.execute();
    },
  };

  readonly segments = {
    /** Idempotent on key (events may be redelivered). Returns false if the source is not in this account. */
    insert: async (s: NewSegment): Promise<boolean> => {
      const source = await this.sources.get(s.source_id);
      if (!source) return false;
      await this.db
        .insertInto("segments")
        .values({ ...s, account_id: this.accountId })
        .onConflict((oc) => oc.column("key").doNothing())
        .execute();
      return true;
    },
    between: (sourceId: string, from: Date, to: Date): Promise<Segment[]> =>
      this.db
        .selectFrom("segments")
        .selectAll()
        .where("source_id", "=", sourceId)
        .where("start_at", ">=", new Date(from.getTime() - 60_000))
        .where("start_at", "<", to)
        .orderBy("start_at")
        .execute(),
  };

  readonly apiKeys = {
    /** Creates a key and returns the plaintext once; only its hash is stored. */
    create: async (name: string, agentId?: string, expiresAt?: Date, userId?: string): Promise<{ id: string; key: string; prefix: string }> => {
      const key = `sk_${randomBytes(24).toString("base64url")}`;
      const id = newId("key");
      await this.db
        .insertInto("api_keys")
        .values({ id, account_id: this.accountId, key_hash: hashApiKey(key), prefix: key.slice(0, 7), name, agent_id: agentId ?? null, expires_at: expiresAt ?? null, user_id: userId ?? null })
        .execute();
      return { id, key, prefix: key.slice(0, 7) };
    },
  };
}

/**
 * The only way code (including external modules) reaches Postgres.
 * Part of the stable extension interface: changes follow semver (ADR 0007).
 */
export class DataAccess {
  private readonly kdb: Kysely<Database>;
  /** Encrypts secrets stored at rest (webhook signing secrets). Set by createApi at startup. */
  secretBox: SecretBox | undefined;
  constructor(db: Kysely<Database>) {
    this.kdb = db;
  }

  /** The secret box, or an error if the API was started without one. */
  box(): SecretBox {
    if (!this.secretBox) throw new Error("secret box not initialised");
    return this.secretBox;
  }

  /** Encrypts any webhook secrets stored in plain text. Idempotent; returns how many changed. */
  async encryptLegacyWebhookSecrets(): Promise<number> {
    const box = this.box();
    const { rows: accounts } = await sql<{ account_id: string }>`select * from accounts_with_plain_webhook_secrets()`.execute(this.kdb);
    let changed = 0;
    for (const { account_id } of accounts) {
      changed += await this.withAccount(account_id, async (s) => {
        const rows = await s.db.selectFrom("webhooks").select(["id", "secret"]).where("secret", "not like", "enc:v1:%").execute();
        for (const r of rows) await s.db.updateTable("webhooks").set({ secret: box.encrypt(r.secret) }).where("id", "=", r.id).execute();
        return rows.length;
      });
    }
    return changed;
  }

  /** Runs fn in a transaction with app.account_id set, so RLS scopes every query. */
  async withAccount<T>(accountId: string, fn: (scope: AccountScope) => Promise<T>): Promise<T> {
    return this.kdb.transaction().execute(async (trx) => {
      await sql`select set_config('app.account_id', ${accountId}, true)`.execute(trx);
      return fn(new AccountScope(accountId, trx));
    });
  }

  readonly accounts = {
    /** Creates an account; the new id is set as the current account so RLS allows the insert. */
    create: async (name: string, retentionDays?: number, kind = "standard"): Promise<{ id: string; name: string }> => {
      const id = randomUUID();
      return this.withAccount(id, (scope) =>
        scope.db
          .insertInto("accounts")
          .values({ id, name, kind, ...(retentionDays ? { retention_days: retentionDays } : {}) })
          .returning(["id", "name"])
          .executeTakeFirstOrThrow(),
      );
    },
  };

  /**
   * The account and (for agent keys) the agent behind a key; undefined if unknown or revoked.
   * Console sessions also carry their user and that user's role in the account (ADR 0044).
   */
  async authenticate(key: string): Promise<Principal | undefined> {
    return this.principalForKeyHash(hashApiKey(key));
  }

  /** The principal for an already hashed key (media links carry a sealed hash, never the key). */
  async principalForKeyHash(hash: string): Promise<Principal | undefined> {
    const { rows } = await sql<{ account_id: string; agent_id: string | null; user_id: string | null; role: Role | null }>`select * from auth_api_key_principal(${hash})`.execute(this.kdb);
    const r = rows[0];
    return r ? { accountId: r.account_id, agentId: r.agent_id, userId: r.user_id, role: r.role } : undefined;
  }

  /** The accounts a user belongs to, oldest membership first (owner-defined function, ADR 0044). */
  async membershipsOf(userId: string): Promise<{ accountId: string; accountName: string; role: Role }[]> {
    const { rows } = await sql<{ account_id: string; account_name: string; role: Role }>`select * from user_memberships(${userId})`.execute(this.kdb);
    return rows.map((r) => ({ accountId: r.account_id, accountName: r.account_name, role: r.role }));
  }

  /** The invite with this token hash, across accounts; undefined if unknown or its account is deleted. */
  async inviteByTokenHash(hash: string): Promise<{ id: string; accountId: string } | undefined> {
    const { rows } = await sql<{ id: string; account_id: string }>`select * from invite_by_token(${hash})`.execute(this.kdb);
    return rows[0] ? { id: rows[0].id, accountId: rows[0].account_id } : undefined;
  }

  /** The connect code with this hash, across accounts (ADR 0048); undefined if unknown or its account is deleted. */
  async connectCodeByHash(hash: string): Promise<{ id: string; accountId: string } | undefined> {
    const { rows } = await sql<{ id: string; account_id: string }>`select * from connect_code_by_hash(${hash})`.execute(this.kdb);
    return rows[0] ? { id: rows[0].id, accountId: rows[0].account_id } : undefined;
  }

  /** The account owning a WHIP source whose live token matches, or undefined (ADR 0034). */
  async authenticateIngestToken(token: string, sourceId: string): Promise<string | undefined> {
    const { rows } = await sql<{ account_id: string | null }>`select auth_ingest_token(${hashApiKey(token)}, ${sourceId}) as account_id`.execute(this.kdb);
    return rows[0]?.account_id ?? undefined;
  }

  /** The bridge and account behind a bridge token, or undefined (ADR 0045). */
  async authenticateBridgeToken(token: string): Promise<{ bridgeId: string; accountId: string } | undefined> {
    const { rows } = await sql<{ bridge_id: string; account_id: string }>`select * from auth_bridge_token(${hashApiKey(token)})`.execute(this.kdb);
    return rows[0] ? { bridgeId: rows[0].bridge_id, accountId: rows[0].account_id } : undefined;
  }

  /** The account of a bridge whose current token hash starts with `hashPrefix` (a bridge camera's WHIP bearer, ADR 0049). */
  async authenticateBridgeWhip(bridgeId: string, hashPrefix: string): Promise<string | undefined> {
    const { rows } = await sql<{ account_id: string | null }>`select auth_bridge_whip(${bridgeId}, ${hashPrefix}) as account_id`.execute(this.kdb);
    return rows[0]?.account_id ?? undefined;
  }

  /** The sensor source and account behind an integration token, or undefined (ADR 0045). */
  async authenticateIntegrationToken(token: string): Promise<{ sourceId: string; accountId: string } | undefined> {
    const { rows } = await sql<{ source_id: string; account_id: string }>`select * from auth_integration_token(${hashApiKey(token)})`.execute(this.kdb);
    return rows[0] ? { sourceId: rows[0].source_id, accountId: rows[0].account_id } : undefined;
  }

  /** Bridges silent for longer than `seconds` that still have cameras not marked offline. */
  async silentBridges(seconds: number): Promise<{ bridge_id: string; account_id: string }[]> {
    const { rows } = await sql<{ bridge_id: string; account_id: string }>`select * from silent_bridges(${seconds})`.execute(this.kdb);
    return rows;
  }

  /** Sensor sources holding readings older than their retention days. */
  async readingsRetentionTargets(): Promise<{ account_id: string; source_id: string; retention_days: number }[]> {
    const { rows } = await sql<{ account_id: string; source_id: string; retention_days: number }>`select * from readings_retention_targets()`.execute(this.kdb);
    return rows;
  }

  async authenticateApiKey(key: string): Promise<string | undefined> {
    const { rows } = await sql<{ account_id: string | null }>`select auth_api_key(${hashApiKey(key)}) as account_id`.execute(
      this.kdb,
    );
    return rows[0]?.account_id ?? undefined;
  }

  readonly secrets = {
    get: async (name: string) =>
      (await this.kdb.selectFrom("instance_secrets").select("value").where("name", "=", name).executeTakeFirst())?.value,
    /** Inserts unless present; returns the stored value (first writer wins across replicas). */
    putIfAbsent: async (name: string, value: string) => {
      await this.kdb.insertInto("instance_secrets").values({ name, value }).onConflict((oc) => oc.column("name").doNothing()).execute();
      return (await this.secrets.get(name))!;
    },
  };

  /** Sources holding raw segments older than their retention (owner-defined function, ADR 0016). */
  async retentionTargets(): Promise<{ account_id: string; source_id: string; retention_days: number }[]> {
    const { rows } = await sql<{ account_id: string; source_id: string; retention_days: number }>`select * from raw_retention_targets()`.execute(this.kdb);
    return rows;
  }

  /** Runs fn only if this process gets the session-level advisory lock; returns undefined otherwise. */
  async tryAdvisoryLock<T>(id: number, fn: () => Promise<T>): Promise<T | undefined> {
    return this.kdb.connection().execute(async (conn) => {
      const { rows } = await sql<{ ok: boolean }>`select pg_try_advisory_lock(${id}) as ok`.execute(conn);
      if (!rows[0]?.ok) return undefined;
      try {
        return await fn();
      } finally {
        await sql`select pg_advisory_unlock(${id})`.execute(conn);
      }
    });
  }

  /** Runs fn holding the session-level advisory lock, waiting for it if another process has it. */
  async withAdvisoryLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
    return this.kdb.connection().execute(async (conn) => {
      await sql`select pg_advisory_lock(${id})`.execute(conn);
      try {
        return await fn();
      } finally {
        await sql`select pg_advisory_unlock(${id})`.execute(conn);
      }
    });
  }

  /** The underlying Kysely instance, for owner-defined functions that work across accounts. */
  db() {
    return this.kdb;
  }

  /** Demo sessions are not account data (one account per session); see ADR 0021. */
  get demoSessions() {
    return this.kdb.selectFrom("demo_sessions");
  }

  /** Watches past their `expires_at`, across accounts (ids only). */
  async expiredWatches(): Promise<{ id: string; account_id: string }[]> {
    return (await sql<{ id: string; account_id: string }>`select * from expired_watches()`.execute(this.kdb)).rows;
  }

  async ping(): Promise<boolean> {
    await sql`select 1`.execute(this.kdb);
    return true;
  }
}
