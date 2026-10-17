// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The API's Ed25519 key (MEDIA_SIGNING_KEY, "kid:base64pem") and everything
// it signs (spec/media/tokens.md, ADR 0049):
// - capture tickets (24 h, in the capture link, exchanged at /v1/capture/join);
// - media join tokens (10 min) for the capture page, WHIP publishers, the
//   camera's feed egress and live viewers;
// - control tokens (60 s, one per control API call);
// - WHIP bearers (no expiry; their jti names the stored credential);
// - callback tokens (the bearer the media plane echoes on every callback).
// The media plane verifies with the public half; the API verifies its own
// tickets, WHIP bearers and callback tokens.
import { randomBytes } from "node:crypto";
import { type JWK, SignJWT, createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, importPKCS8, jwtVerify } from "jose";
import type { DataAccess } from "./data/access.js";

export interface CaptureTicket {
  accountId: string;
  sourceId: string;
  recordAudio: boolean;
  /** The source's capture epoch when issued; rotating the link bumps it (ADR 0038). */
  epoch?: number;
  /** Seconds since the epoch, set when verifying. */
  issuedAt?: number;
}

/** An unbound capture link must be used for the first time within this many seconds (ADR 0038). */
export const UNBOUND_TICKET_SECONDS = 10 * 60;
export const JOIN_TOKEN_MAX_TTL_SECONDS = 15 * 60;
const TICKET_AUDIENCE = "senseplane-capture";
const CALLBACK_AUDIENCE = "senseplane-media-callback";

/** A camera's room on the media plane (plain names, no tenant prefix: ADR 0049). */
export const roomFor = (sourceId: string) => `sp-${sourceId}`;
export const sourceOfRoom = (room: string) => (room.startsWith("sp-") ? room.slice(3) : undefined);

export type Via = "capture" | "whip";

export interface CallbackClaims {
  accountId: string;
  sourceId: string;
  /** "room": a room's callback; "feed": an egress session's. */
  kind: "room" | "feed";
  sessionId?: string;
}

export interface IngestSigner {
  kid: string;
  issuer: string;
  jwks: { keys: JWK[] };
  /** MEDIA_TOKEN_PUBLIC_KEYS for this key (what the media plane trusts). */
  publicRing: string;
  signTicket(t: CaptureTicket, ttlSeconds: number): Promise<{ token: string; expiresAt: Date }>;
  verifyTicket(token: string): Promise<CaptureTicket>;
  /** A publisher's join token (capture page or WHIP). */
  signJoin(
    t: CaptureTicket & { name?: string; maxResolution?: "720p" | "1080p"; maxActiveSources?: number; via?: Via },
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: Date }>;
  /** Live view (ADR 0042): subscribe-only; `sessionId` is the jti (single use). */
  signViewer(
    t: { accountId: string; sourceId: string; sessionId: string; audio: boolean; idleTimeoutSeconds: number; maxLiveViewers?: number | null },
    ttlSeconds: number,
  ): Promise<{ token: string; expiresAt: Date }>;
  /** The camera's feed egress: kind egress over a plain transport. */
  signFeed(t: { sourceId: string; recordAudio: boolean }, ttlSeconds?: number): Promise<string>;
  signControl(): Promise<string>;
  /** A WHIP bearer for a camera; `jti` names the credential so it can be revoked. */
  signWhip(t: { sourceId: string; jti: string; authorizeUrl: string }): Promise<string>;
  verifyWhip(token: string): Promise<{ sourceId: string; jti: string }>;
  signCallback(c: CallbackClaims): Promise<string>;
  verifyCallback(token: string): Promise<CallbackClaims>;
}

export function isProduction(env = process.env): boolean {
  return env.NODE_ENV === "production" || env.SENSEPLANE_MODE === "production";
}

/** `kid:base64pem` (base64 of a PKCS#8 PEM), or a raw PEM. */
export function parseSigningKey(value: string): { kid?: string; pem: string } {
  const v = value.trim();
  if (v.includes("-----BEGIN")) return { pem: v.replace(/\\n/g, "\n") };
  const i = v.indexOf(":");
  if (i <= 0) throw new Error("MEDIA_SIGNING_KEY must be kid:base64pem");
  return { kid: v.slice(0, i), pem: Buffer.from(v.slice(i + 1), "base64").toString("utf8") };
}

const SECRET_NAME = "ingest_signing_key_pkcs8";
const now = () => Math.floor(Date.now() / 1000);
const jti = () => randomBytes(12).toString("base64url");

/**
 * Uses MEDIA_SIGNING_KEY. Outside production a key is generated and stored in
 * the database when none is given (the media plane must then be given its
 * public half); in production it must be supplied as a secret.
 */
export async function createIngestSigner(
  data: DataAccess,
  value = process.env.MEDIA_SIGNING_KEY ?? process.env.INGEST_SIGNING_KEY,
  issuer = process.env.MEDIA_ISSUER ?? "senseplane",
): Promise<IngestSigner> {
  let parsed = value ? parseSigningKey(value) : undefined;
  if (!parsed) {
    if (isProduction()) throw new Error("MEDIA_SIGNING_KEY is required in production");
    let pem = await data.secrets.get(SECRET_NAME);
    if (!pem) {
      const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
      pem = await data.secrets.putIfAbsent(SECRET_NAME, await exportPKCS8(privateKey));
    }
    parsed = { pem };
  }
  const privateKey = await importPKCS8(parsed.pem, "EdDSA", { extractable: true });
  const full = await exportJWK(privateKey);
  const kid = parsed.kid ?? `ingest-${full.x!.slice(0, 8)}`;
  const publicJwk: JWK = { kty: full.kty, crv: full.crv, x: full.x, alg: "EdDSA", use: "sig", kid };
  const jwks = { keys: [publicJwk] };
  const localKeys = createLocalJWKSet(jwks);
  // Capture links issued before MEDIA_SIGNING_KEY was set keep working (verify only).
  const legacyPem = parsed.kid ? await data.secrets.get(SECRET_NAME) : undefined;
  let legacy: ReturnType<typeof createLocalJWKSet> | undefined;
  if (legacyPem && legacyPem !== parsed.pem) {
    const l = await exportJWK(await importPKCS8(legacyPem, "EdDSA", { extractable: true }));
    legacy = createLocalJWKSet({ keys: [{ kty: l.kty, crv: l.crv, x: l.x, alg: "EdDSA", kid: `ingest-${l.x!.slice(0, 8)}` }] });
  }
  const publicPem = await (async () => {
    const { createPublicKey } = await import("node:crypto");
    return createPublicKey({ key: parsed!.pem, format: "pem" }).export({ type: "spki", format: "pem" }).toString();
  })();
  const sign = (claims: Record<string, unknown>) => new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid }).sign(privateKey);
  const publisherGrants = (audio: boolean, extra: { maxResolution?: string; maxActiveSources?: number }) => ({
    canPublish: true, canSubscribe: false, canPublishData: false, publishKinds: audio ? ["video", "audio"] : ["video"],
    ...(extra.maxResolution ? { maxResolution: extra.maxResolution } : {}), ...(extra.maxActiveSources ? { maxActiveSources: extra.maxActiveSources } : {}),
  });

  return {
    kid,
    issuer,
    jwks,
    publicRing: `${kid}:${Buffer.from(publicPem).toString("base64")}`,
    async signTicket(t, ttlSeconds) {
      const exp = now() + ttlSeconds;
      const token = await new SignJWT({ acc: t.accountId, rec_audio: t.recordAudio, ep: t.epoch ?? 0 })
        .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid })
        .setSubject(t.sourceId).setAudience(TICKET_AUDIENCE).setIssuer(issuer).setIssuedAt().setExpirationTime(exp)
        .sign(privateKey);
      return { token, expiresAt: new Date(exp * 1000) };
    },
    async verifyTicket(token) {
      const opts = { audience: TICKET_AUDIENCE, issuer, algorithms: ["EdDSA"] };
      const { payload } = await jwtVerify(token, localKeys, opts).catch((err) => {
        if (!legacy) throw err;
        return jwtVerify(token, legacy, { ...opts, issuer: undefined });
      });
      return {
        accountId: String(payload.acc), sourceId: String(payload.sub), recordAudio: payload.rec_audio === true,
        epoch: typeof payload.ep === "number" ? payload.ep : 0, issuedAt: typeof payload.iat === "number" ? payload.iat : 0,
      };
    },
    async signJoin(t, ttlSeconds) {
      if (ttlSeconds > JOIN_TOKEN_MAX_TTL_SECONDS) throw new Error(`join tokens live at most ${JOIN_TOKEN_MAX_TTL_SECONDS}s`);
      const iat = now();
      // Exactly the protocol's claim set (spec/media/signalling.json#/$defs/joinClaims).
      const claims = {
        v: 1, iss: issuer, aud: "media", room: roomFor(t.sourceId), identity: `${t.sourceId}:${t.via ?? "capture"}`,
        ...(t.name ? { name: t.name.slice(0, 200) } : {}),
        kind: t.via === "whip" ? "ingress" : "human", transport: "webrtc",
        grants: publisherGrants(t.recordAudio, t), jti: jti(), iat, exp: iat + ttlSeconds,
      };
      return { token: await sign(claims), expiresAt: new Date(claims.exp * 1000) };
    },
    async signViewer(t, ttlSeconds) {
      if (ttlSeconds > JOIN_TOKEN_MAX_TTL_SECONDS) throw new Error(`join tokens live at most ${JOIN_TOKEN_MAX_TTL_SECONDS}s`);
      const iat = now();
      const claims = {
        v: 1, iss: issuer, aud: "media", room: roomFor(t.sourceId), identity: `${t.sourceId}:viewer:${t.sessionId}`, kind: "human", transport: "webrtc",
        grants: {
          canPublish: false, canSubscribe: true, canPublishData: false,
          subscribeKinds: t.audio ? ["video", "audio"] : ["video"],
          idleTimeoutSeconds: t.idleTimeoutSeconds,
          ...(t.maxLiveViewers ? { maxLiveViewers: t.maxLiveViewers } : {}),
        },
        jti: t.sessionId, iat, exp: iat + ttlSeconds,
      };
      return { token: await sign(claims), expiresAt: new Date(claims.exp * 1000) };
    },
    async signFeed(t, ttlSeconds = 600) {
      const iat = now();
      return sign({
        v: 1, iss: issuer, aud: "media", room: roomFor(t.sourceId), identity: `${t.sourceId}:feed`, kind: "egress", transport: "pipe",
        grants: {
          canPublish: false, canSubscribe: true, canPublishData: false, subscribeExempt: true, maxSubscriptions: 4,
          subscribeKinds: t.recordAudio ? ["video", "audio"] : ["video"],
        },
        jti: jti(), iat, exp: iat + ttlSeconds,
      });
    },
    async signControl() {
      const iat = now();
      return sign({ v: 1, iss: issuer, aud: "control", jti: jti(), iat, exp: iat + 60 });
    },
    async signWhip(t) {
      return sign({ v: 1, iss: issuer, aud: "whip", room: roomFor(t.sourceId), authorize_url: t.authorizeUrl, jti: t.jti, iat: now() });
    },
    async verifyWhip(token) {
      const { payload } = await jwtVerify(token, localKeys, { audience: "whip", issuer, algorithms: ["EdDSA"] });
      const sourceId = sourceOfRoom(String(payload.room ?? ""));
      if (!sourceId || typeof payload.jti !== "string") throw new Error("not a camera's WHIP bearer");
      return { sourceId, jti: payload.jti };
    },
    async signCallback(c) {
      return sign({ aud: CALLBACK_AUDIENCE, iss: issuer, acc: c.accountId, src: c.sourceId, k: c.kind, ...(c.sessionId ? { sid: c.sessionId } : {}), iat: now() });
    },
    async verifyCallback(token) {
      const { payload } = await jwtVerify(token, localKeys, { audience: CALLBACK_AUDIENCE, issuer, algorithms: ["EdDSA"] });
      if (typeof payload.acc !== "string" || typeof payload.src !== "string" || (payload.k !== "room" && payload.k !== "feed")) throw new Error("bad callback token");
      return { accountId: payload.acc, sourceId: payload.src, kind: payload.k, ...(typeof payload.sid === "string" ? { sessionId: payload.sid } : {}) };
    },
  };
}

const DEFAULT_DB_PASSWORDS = new Set(["senseplane", "senseplane_app"]);

/**
 * Refuses to run production with any of the compose development credentials
 * or public URLs derived from the Host header (ADR 0035). Returns the
 * problems instead of throwing when `check` is set.
 */
export function defaultCredentialProblems(env = process.env): string[] {
  if (!isProduction(env)) return [];
  const problems: string[] = [];
  for (const name of ["DATABASE_URL", "MIGRATION_DATABASE_URL"]) {
    const v = env[name];
    if (!v) continue;
    try {
      if (DEFAULT_DB_PASSWORDS.has(decodeURIComponent(new URL(v).password))) problems.push(`${name} uses a development password`);
    } catch {
      /* not a URL: the driver will complain */
    }
  }
  if (env.S3_SECRET_ACCESS_KEY === "senseplane-secret") problems.push("S3_SECRET_ACCESS_KEY is the development default");
  if (env.MEDIA_SIGNING_KEY?.startsWith("dev-")) problems.push("MEDIA_SIGNING_KEY is the development key (run deploy/compose/init-secrets.sh)");
  if (env.VALKEY_URL) {
    let pass = "";
    try {
      pass = decodeURIComponent(new URL(env.VALKEY_URL).password);
    } catch {
      /* ignore */
    }
    if (!pass && !env.VALKEY_PASSWORD) problems.push("Valkey needs a password (VALKEY_PASSWORD or in VALKEY_URL) in production");
    if ((pass || env.VALKEY_PASSWORD || "").startsWith("dev-")) problems.push("the Valkey password is a development default");
  }
  if (!env.API_PUBLIC_URL) problems.push("API_PUBLIC_URL is required in production (public URLs must not follow the Host header)");
  return problems;
}

export function assertNoDefaultCredentials(env = process.env) {
  const problems = defaultCredentialProblems(env);
  if (problems.length) throw new Error(`Refusing to start: ${problems.join("; ")}`);
}
