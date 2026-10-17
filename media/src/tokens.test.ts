// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The golden token vectors (spec/media/vectors/tokens.json): this verifier
// accepts and refuses exactly as they say.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReplayGuard, keyObjects, parseKeyring, verifyControlToken, verifyJoinToken, verifyWhipToken } from "./tokens.js";

const vectors = JSON.parse(readFileSync(new URL("../../spec/media/vectors/tokens.json", import.meta.url), "utf8")) as {
  issuer: string; now: number; ring: string;
  keys: Record<string, { public_pem: string; private_pem: string }>;
  cases: { name: string; audience: "media" | "control" | "whip"; token: string; expect: { ok: true; claims: unknown } | { ok: false; reason: string } }[];
};
const ring = { issuer: vectors.issuer, keys: keyObjects(parseKeyring(vectors.ring)) };
const verify = { media: verifyJoinToken, control: verifyControlToken, whip: verifyWhipToken };

describe("media token vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const got = verify[c.audience](c.token, ring, { now: vectors.now });
      if (c.expect.ok) {
        expect(got).toMatchObject({ ok: true, kid: "vectors-1" });
        expect(got.ok && got.claims).toEqual(c.expect.claims);
      } else {
        expect(got).toEqual({ ok: false, reason: c.expect.reason });
      }
    });
  }
});

describe("key ring", () => {
  it("reads kid:base64pem pairs and raw PEMs, and refuses private keys", () => {
    const pem = vectors.keys["vectors-1"]!.public_pem;
    expect(Object.keys(parseKeyring(`a:${Buffer.from(pem).toString("base64")},b:${Buffer.from(pem).toString("base64")}`))).toEqual(["a", "b"]);
    expect(parseKeyring(JSON.stringify({ c: pem })).c).toBe(pem);
    expect(() => parseKeyring(`p:${Buffer.from(vectors.keys["vectors-1"]!.private_pem).toString("base64")}`)).toThrow(/private key/);
    expect(() => parseKeyring("nokid")).toThrow(/kid:base64pem/);
  });

  it("consumes a jti once", () => {
    const g = new ReplayGuard();
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(g.consume("jti-00000001", exp)).toBe("fresh");
    expect(g.consume("jti-00000001", exp)).toBe("replayed");
    expect(g.consume("jti-00000002", exp)).toBe("fresh");
  });
});
