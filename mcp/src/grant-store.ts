// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Server-side state for OAuth authorization codes. Codes and tokens stay sealed
// (stateless), but a code may be exchanged only once (OAuth 2.1 §4.1.3): the
// store records each code's id when it is redeemed, and a second redemption
// revokes every token issued from that code.
//
// The in-memory store is enough for one MCP instance. Several instances must
// share state, so with VALKEY_URL set the service uses Valkey (ADR 0051).
import type { Redis } from "ioredis";

export interface OAuthGrantStore {
  /** True the first time a code id is redeemed, false on every later attempt. */
  consume(id: string, ttlS: number): Promise<boolean>;
  /** Revoke all tokens issued from this code id. */
  revoke(id: string, ttlS: number): Promise<void>;
  isRevoked(id: string): Promise<boolean>;
}

export function memoryGrantStore(): OAuthGrantStore {
  const used = new Map<string, number>();
  const revoked = new Map<string, number>();
  const live = (m: Map<string, number>, id: string) => {
    const exp = m.get(id);
    if (exp === undefined) return false;
    if (exp < Date.now()) {
      m.delete(id);
      return false;
    }
    return true;
  };
  return {
    async consume(id, ttlS) {
      if (live(used, id)) return false;
      used.set(id, Date.now() + ttlS * 1000);
      return true;
    },
    async revoke(id, ttlS) {
      revoked.set(id, Date.now() + ttlS * 1000);
    },
    async isRevoked(id) {
      return live(revoked, id);
    },
  };
}

/** Shared store on Valkey (spec/brain/valkey.json `mcp`); `SET NX` is atomic, so only one instance wins a redemption. */
export function valkeyGrantStore(r: Redis): OAuthGrantStore {
  return {
    async consume(id, ttlS) {
      return (await r.set(`sp:mcp:used:${id}`, "1", "EX", ttlS, "NX")) === "OK";
    },
    async revoke(id, ttlS) {
      await r.set(`sp:mcp:revoked:${id}`, "1", "EX", ttlS);
    },
    async isRevoked(id) {
      return (await r.exists(`sp:mcp:revoked:${id}`)) === 1;
    },
  };
}
