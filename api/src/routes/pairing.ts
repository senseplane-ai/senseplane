// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Pairing a bridge with a code (ADR 0061), so a Home Assistant box needs no
// token pasted into it:
// - POST /v1/bridge/pair         the box asks for a code (no auth; limited per address)
// - POST /v1/bridge/pair/token   the box polls with its device code: waiting,
//                                expired, or its bridge token, once
// - GET  /v1/bridges/pair        the console looks a code up (the box's name)
// - POST /v1/bridges/pair        a workspace admin approves it: a bridge is
//                                made for the box, its token sealed for it
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { DataAccess } from "../data/access.js";
import { hashApiKey } from "../data/access.js";
import { ApiError } from "../errors.js";
import type { AuditLog } from "../module.js";
import { limiter } from "../rate-limit.js";
import { newBridgeToken } from "./sources.js";

/** How long a code waits for a person, and how often the box should ask. */
export const PAIR_TTL_SECONDS = 15 * 60;
export const PAIR_POLL_SECONDS = 5;

// No 0/O, 1/I/L or vowels (no words in codes).
const ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";
export const newUserCode = () => {
  const c = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};
/** "bcdf ghjk", "BCDFGHJK" → "BCDF-GHJK"; undefined if it can't be a code. */
export function normalizeCode(input: string): string | undefined {
  const c = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 8 || [...c].some((x) => !ALPHABET.includes(x))) return undefined;
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
const hash = (deviceCode: string) => createHash("sha256").update(deviceCode).digest("hex");

export interface PairingDeps {
  data: DataAccess;
  /** Where the console is, for the link the box shows; else the request's own base. */
  consoleUrl?: string;
  audit?: AuditLog;
  startsPerHour?: number;
}

export function registerPairingRoutes(app: FastifyInstance, deps: PairingDeps) {
  const startAllowed = limiter(deps.startsPerHour ?? 20, 3600_000);
  const pollAllowed = limiter(60, 60_000);
  const approveAllowed = limiter(30, 60_000);
  const db = () => deps.data.db();

  app.post<{ Body: { name?: string } }>(
    "/v1/bridge/pair",
    { schema: { body: { type: "object", additionalProperties: false, properties: { name: { type: "string", minLength: 1, maxLength: 120 } } } } },
    async (req, reply) => {
      if (!startAllowed(req.ip)) throw new ApiError(429, "rate_limited", "Too many pairing codes from this address; try again later.");
      const deviceCode = `brgp_${randomBytes(32).toString("base64url")}`;
      const until = new Date(Date.now() + PAIR_TTL_SECONDS * 1000);
      const name = (req.body?.name ?? "Home Assistant").slice(0, 120);
      let userCode: string | undefined;
      for (let i = 0; i < 5 && !userCode; i++) {
        const code = newUserCode();
        const ok = await sql<{ ok: boolean }>`select bridge_pairing_start(${hash(deviceCode)}, ${code}, ${name}, ${until}) as ok`.execute(db());
        if (ok.rows[0]?.ok) userCode = code;
      }
      if (!userCode) throw new ApiError(503, "service_unavailable", "Couldn't make a pairing code; try again.");
      const base = (deps.consoleUrl ?? `${req.protocol}://${req.host}`).replace(/\/$/, "");
      return reply.code(201).send({
        device_code: deviceCode, user_code: userCode,
        verification_url: `${base}/link`, verification_url_complete: `${base}/link?code=${userCode}`,
        expires_in: PAIR_TTL_SECONDS, interval: PAIR_POLL_SECONDS,
      });
    },
  );

  app.post<{ Body: { device_code: string } }>(
    "/v1/bridge/pair/token",
    { schema: { body: { type: "object", additionalProperties: false, required: ["device_code"], properties: { device_code: { type: "string", minLength: 10, maxLength: 100 } } } } },
    async (req) => {
      if (!pollAllowed(req.ip)) throw new ApiError(429, "rate_limited", `Ask at most every ${PAIR_POLL_SECONDS} s.`);
      const r = (await sql<{ status: string; bridge_id: string | null; token_sealed: string | null }>`select * from bridge_pairing_take(${hash(req.body.device_code)})`.execute(db())).rows[0];
      if (!r || r.status === "unknown") throw new ApiError(404, "not_found", "no pairing with this device code");
      if (r.status === "approved" && r.token_sealed) return { status: "approved", bridge_id: r.bridge_id, token: deps.data.box().decrypt(r.token_sealed) };
      // Taken already: a second box can't collect the same token.
      if (r.status === "taken") throw new ApiError(409, "conflict", "this pairing was already used; ask for a new code");
      return { status: r.status, interval: PAIR_POLL_SECONDS };
    },
  );

  app.get<{ Querystring: { code?: string } }>("/v1/bridges/pair", async (req) => {
    const code = normalizeCode(req.query.code ?? "");
    const found = code ? (await sql<{ name: string; expires_at: Date }>`select * from bridge_pairing_find(${code})`.execute(db())).rows[0] : undefined;
    if (!found) throw new ApiError(404, "not_found", "No box is waiting with this code. Check it, or ask the box for a new one.");
    return { code, name: found.name, expires_at: new Date(found.expires_at).toISOString() };
  });

  app.post<{ Body: { code: string; name?: string } }>(
    "/v1/bridges/pair",
    { schema: { body: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", maxLength: 20 }, name: { type: "string", minLength: 1, maxLength: 120 } } } } },
    async (req, reply) => {
      const accountId = req.accountId!;
      if (!approveAllowed(accountId)) throw new ApiError(429, "rate_limited", "Too many tries; wait a minute.");
      const code = normalizeCode(req.body.code);
      const found = code ? (await sql<{ name: string }>`select * from bridge_pairing_find(${code})`.execute(db())).rows[0] : undefined;
      if (!code || !found) throw new ApiError(404, "not_found", "No box is waiting with this code. Check it, or ask the box for a new one.");
      const token = newBridgeToken();
      const bridge = await deps.data.withAccount(accountId, (s) => s.db.insertInto("bridges").values({
        id: `brg_${randomBytes(9).toString("base64url")}`, account_id: accountId, name: req.body.name ?? found.name,
        token_hash: hashApiKey(token), prefix: token.slice(0, 8),
      }).returning(["id", "name", "created_at"]).executeTakeFirstOrThrow());
      const ok = (await sql<{ ok: boolean }>`select bridge_pairing_approve(${code}, ${accountId}::uuid, ${bridge.id}, ${deps.data.box().encrypt(token)}) as ok`.execute(db())).rows[0]?.ok;
      if (!ok) {
        // Expired or approved by someone else in between.
        await deps.data.withAccount(accountId, (s) => s.db.deleteFrom("bridges").where("id", "=", bridge.id).execute());
        throw new ApiError(404, "not_found", "This code has expired. Ask the box for a new one.");
      }
      await deps.audit?.write({ accountId, actor: req.access?.actor ?? "account", action: "bridge.paired", target: bridge.id, status: 201 });
      return reply.code(201).send({ id: bridge.id, name: bridge.name, created_at: new Date(bridge.created_at).toISOString() });
    },
  );
}
