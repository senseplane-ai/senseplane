// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { memoryGrantStore, valkeyGrantStore, type OAuthGrantStore } from "./grant-store.js";

// The Valkey store runs against a Valkey (TEST_VALKEY_URL, default db 13 of the
// dev container); without one it is skipped with a note.
const URL_ = process.env.TEST_VALKEY_URL ?? "redis://127.0.0.1:47379/13";
const r = new Redis(URL_, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
const up = await r.connect().then(() => true, () => false);
if (!up) console.warn(`[mcp] skipping the Valkey grant store test: nothing answers at ${URL_.replace(/\/\/[^@/]*@/, "//***@")}. Set TEST_VALKEY_URL to run it.`);
afterAll(() => r.disconnect());

const contract = (name: string, make: () => Promise<OAuthGrantStore>) =>
  describe(name, () => {
    it("redeems a code once and remembers revocations", async () => {
      const s = await make();
      const id = `t${Math.random()}`.replace(".", "");
      expect(await s.consume(id, 60)).toBe(true);
      expect(await s.consume(id, 60)).toBe(false);
      expect(await s.isRevoked(id)).toBe(false);
      await s.revoke(id, 60);
      expect(await s.isRevoked(id)).toBe(true);
    });
  });

contract("memory grant store", async () => memoryGrantStore());
describe.skipIf(!up)("with Valkey", () => contract("Valkey grant store", async () => valkeyGrantStore(r)));
