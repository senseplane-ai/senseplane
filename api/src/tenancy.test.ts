// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataAccess } from "./data/access.js";
import { createDb } from "./data/db.js";
import { createTestDatabase } from "./testdb.js";

describe("tenancy (row-level security)", () => {
  let drop: () => Promise<void>;
  let db: ReturnType<typeof createDb>;
  let data: DataAccess;
  let a: string;
  let b: string;
  let aSourceId: string;

  beforeAll(async () => {
    const t = await createTestDatabase();
    drop = t.drop;
    db = createDb(t.appUrl);
    data = new DataAccess(db);
    a = (await data.accounts.create("Account A")).id;
    b = (await data.accounts.create("Account B")).id;
    aSourceId = (await data.withAccount(a, (s) => s.sources.create({ name: "Front door", type: "browser" }))).id;
  });

  afterAll(async () => {
    await db?.destroy();
    await drop?.();
  });

  it("runs as a role that cannot bypass RLS", async () => {
    const { rows } = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
      select rolsuper, rolbypassrls from pg_roles where rolname = current_user`.execute(db);
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("lets an account read its own rows", async () => {
    const list = await data.withAccount(a, (s) => s.sources.list());
    expect(list.map((x) => x.id)).toEqual([aSourceId]);
    expect(list[0]!.id).toMatch(/^src_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("hides another account's rows, even when queried by id", async () => {
    expect(await data.withAccount(b, (s) => s.sources.list())).toEqual([]);
    expect(await data.withAccount(b, (s) => s.sources.get(aSourceId))).toBeUndefined();
    const accounts = await data.withAccount(b, (s) => s.db.selectFrom("accounts").select("id").execute());
    expect(accounts.map((x) => x.id)).toEqual([b]);
  });

  it("returns nothing when no account is set", async () => {
    const rows = await db.selectFrom("sources").selectAll().execute();
    expect(rows).toEqual([]);
  });

  it("rejects writes into another account", async () => {
    await expect(
      data.withAccount(b, (s) =>
        s.db.insertInto("sources").values({ id: "src_evil", account_id: a, name: "x", type: "browser" }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      data.withAccount(b, (s) => s.db.updateTable("sources").set({ name: "hijacked" }).where("id", "=", aSourceId).execute()),
    ).resolves.toEqual([expect.objectContaining({ numUpdatedRows: 0n })]);
  });

  it("does not leak the account setting between transactions", async () => {
    await data.withAccount(a, async () => undefined);
    const { rows } = await sql<{ v: string | null }>`select current_setting('app.account_id', true) as v`.execute(db);
    expect(rows[0]!.v ?? "").toBe("");
  });
});
