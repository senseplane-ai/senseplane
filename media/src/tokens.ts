// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Verifies the media contract's three tokens (spec/media/tokens.md): join
// (aud "media"), control (aud "control") and WHIP bearers (aud "whip").
// EdDSA only, a kid from a static public ring, our issuer, the exact claim
// set, 30 s skew. Pure: no clock unless given, no I/O. Single use is the
// ReplayGuard's job, applied by the caller after a token verifies.
import { createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";

export type Rejection =
  | "malformed" | "unknown_kid" | "bad_signature" | "expired" | "not_yet_valid" | "ttl_too_long"
  | "wrong_audience" | "wrong_issuer" | "wrong_room" | "bad_claims" | "bad_transport";

export type ParticipantKind = "human" | "agent" | "egress" | "sip" | "ingress";
export type TransportKind = "webrtc" | "plain" | "pipe";
export type SubscribeRule = { mode: "all" } | { mode: "none" } | { mode: "allow" | "deny"; identities: string[] };

export interface Grants {
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
  subscribe?: SubscribeRule;
  visibleTo?: SubscribeRule;
  publishKinds?: ("audio" | "video" | "screen")[];
  subscribeExempt?: boolean;
  maxSubscriptions?: number;
  subscribeKinds?: ("audio" | "video")[];
  maxResolution?: "720p" | "1080p";
  idleTimeoutSeconds?: number;
  maxLiveViewers?: number;
  maxActiveSources?: number;
}

export interface JoinClaims {
  v: 1; iss: string; aud: "media"; room: string; identity: string; name?: string;
  kind: ParticipantKind; transport: TransportKind; grants: Grants; jti: string; iat: number; nbf?: number; exp: number;
}
export interface ControlClaims { v: 1; iss: string; aud: "control"; jti: string; iat: number; nbf?: number; exp: number }
export interface WhipClaims { v?: 1; iss: string; aud: "whip"; room: string; authorize_url: string; jti: string; iat: number; nbf?: number; exp?: number }

export type Verified<T> = { ok: true; claims: T; kid: string } | { ok: false; reason: Rejection };

export interface Ring {
  issuer: string;
  keys: Record<string, KeyObject>;
  skewSeconds?: number;
  /** Join and control tokens: exp - iat ceiling (default and protocol maximum 900). */
  maxTtlSeconds?: number;
}

const MAX_TTL = 900;

/**
 * `kid:base64pem` pairs, comma separated (base64 of a PEM-encoded SPKI key;
 * a raw PEM is accepted too), or a JSON object of kid → PEM. Refuses a
 * private key: a verifier on the internet must not be able to mint.
 */
export function parseKeyring(value: string, name = "key ring"): Record<string, string> {
  const out: Record<string, string> = {};
  const entries: [string, string][] = value.trim().startsWith("{")
    ? Object.entries(JSON.parse(value) as Record<string, string>)
    : value.split(",").map((e) => e.trim()).filter(Boolean).map((e) => {
        const i = e.indexOf(":");
        if (i <= 0) throw new Error(`${name}: expected kid:base64pem`);
        return [e.slice(0, i), e.slice(i + 1)];
      });
  for (const [kid, raw] of entries) {
    const pem = raw.includes("-----BEGIN") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8");
    if (/PRIVATE KEY/.test(pem)) throw new Error(`${name}: ${kid} is a private key; the media plane holds public keys only`);
    if (!/-----BEGIN PUBLIC KEY-----/.test(pem)) throw new Error(`${name}: ${kid} is not a PEM public key`);
    out[kid] = pem;
  }
  return out;
}

export function keyObjects(pems: Record<string, string>): Record<string, KeyObject> {
  const out: Record<string, KeyObject> = Object.create(null);
  for (const [kid, pem] of Object.entries(pems)) out[kid] = createPublicKey(pem);
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = 1, max = Number.MAX_SAFE_INTEGER) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isStr = (v: unknown, min = 1, max = Infinity) => typeof v === "string" && v.length >= min && v.length <= max;
const only = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const enumOf = <T extends string>(v: unknown, values: readonly T[]): v is T => typeof v === "string" && (values as readonly string[]).includes(v);

const KINDS = ["human", "agent", "egress", "sip", "ingress"] as const;
const TRANSPORTS = ["webrtc", "plain", "pipe"] as const;
const GRANT_KEYS = [
  "canPublish", "canSubscribe", "canPublishData", "subscribe", "visibleTo", "publishKinds", "subscribeExempt", "maxSubscriptions",
  "subscribeKinds", "maxResolution", "idleTimeoutSeconds", "maxLiveViewers", "maxActiveSources",
] as const;

function validRule(r: unknown): boolean {
  if (!isObj(r)) return false;
  if (r.mode === "all" || r.mode === "none") return only(r, ["mode"]);
  if (r.mode === "allow" || r.mode === "deny") {
    return only(r, ["mode", "identities"]) && Array.isArray(r.identities) && r.identities.length <= 500 && r.identities.every((i) => typeof i === "string");
  }
  return false;
}

/** The grants schema alone (strict, typed). */
function validGrants(g: unknown): g is Grants {
  if (!isObj(g) || !only(g, GRANT_KEYS)) return false;
  if (typeof g.canPublish !== "boolean" || typeof g.canSubscribe !== "boolean" || typeof g.canPublishData !== "boolean") return false;
  if (g.subscribe !== undefined && !validRule(g.subscribe)) return false;
  if (g.visibleTo !== undefined && !validRule(g.visibleTo)) return false;
  if (g.publishKinds !== undefined && !(Array.isArray(g.publishKinds) && g.publishKinds.every((k) => enumOf(k, ["audio", "video", "screen"])))) return false;
  if (g.subscribeExempt !== undefined && typeof g.subscribeExempt !== "boolean") return false;
  if (g.maxSubscriptions !== undefined && !isInt(g.maxSubscriptions, 1, 5000)) return false;
  if (g.subscribeKinds !== undefined) {
    const k = g.subscribeKinds;
    if (!Array.isArray(k) || k.length < 1 || k.length > 2 || !k.every((x) => enumOf(x, ["audio", "video"]))) return false;
  }
  if (g.maxResolution !== undefined && !enumOf(g.maxResolution, ["720p", "1080p"])) return false;
  if (g.idleTimeoutSeconds !== undefined && !isInt(g.idleTimeoutSeconds, 1, 86_400)) return false;
  if (g.maxLiveViewers !== undefined && !isInt(g.maxLiveViewers, 1, 100_000)) return false;
  if (g.maxActiveSources !== undefined && !isInt(g.maxActiveSources, 1, 100_000)) return false;
  return true;
}

/** The cross-field grant rules (tokens.md), true when they hold. */
export function grantsValidForKind(g: Grants, kind: ParticipantKind): boolean {
  if (kind === "human" && g.subscribeExempt) return false;
  if (g.subscribeExempt && g.maxSubscriptions === undefined) return false;
  if (!g.canSubscribe && (g.subscribe || g.subscribeExempt || g.maxSubscriptions || g.subscribeKinds)) return false;
  if (!g.canPublish && g.publishKinds?.length) return false;
  return true;
}

function validJoinClaims(p: Record<string, unknown>): boolean {
  return only(p, ["v", "iss", "aud", "room", "identity", "name", "kind", "transport", "grants", "jti", "iat", "nbf", "exp"])
    && p.v === 1 && isStr(p.iss) && p.aud === "media" && isStr(p.room, 1, 200) && isStr(p.identity, 1, 200)
    && (p.name === undefined || isStr(p.name, 0, 200)) && enumOf(p.kind, KINDS) && enumOf(p.transport, TRANSPORTS)
    && validGrants(p.grants) && isStr(p.jti, 8) && isInt(p.iat) && (p.nbf === undefined || isInt(p.nbf)) && isInt(p.exp);
}

function validControlClaims(p: Record<string, unknown>): boolean {
  return only(p, ["v", "iss", "aud", "jti", "iat", "nbf", "exp"]) && p.v === 1 && isStr(p.iss) && p.aud === "control"
    && isStr(p.jti, 8) && isInt(p.iat) && (p.nbf === undefined || isInt(p.nbf)) && isInt(p.exp);
}

function validUrl(u: unknown): boolean {
  if (!isStr(u, 1, 2048) || !/^https?:\/\//i.test(u as string)) return false;
  try {
    new URL(u as string);
    return true;
  } catch {
    return false;
  }
}

function validWhipClaims(p: Record<string, unknown>): boolean {
  return only(p, ["v", "iss", "aud", "room", "authorize_url", "jti", "iat", "nbf", "exp"]) && (p.v === undefined || p.v === 1)
    && isStr(p.iss) && p.aud === "whip" && isStr(p.room, 1, 200) && validUrl(p.authorize_url) && isStr(p.jti, 8, 200)
    && isInt(p.iat) && (p.nbf === undefined || isInt(p.nbf)) && (p.exp === undefined || isInt(p.exp));
}

function decode(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/** Signature, audience and issuer; returns the payload. Nothing is read from the payload before the signature checks out. */
function verifyCompact(token: string, ring: Ring, audience: "media" | "control" | "whip"): { ok: true; payload: Record<string, unknown>; kid: string } | { ok: false; reason: Rejection } {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, b, s] = parts as [string, string, string];
  let header: unknown;
  try {
    header = decode(h);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isObj(header) || header.alg !== "EdDSA" || typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "malformed" };
  if (!Object.hasOwn(ring.keys, header.kid)) return { ok: false, reason: "unknown_kid" };
  const key = ring.keys[header.kid];
  if (!key) return { ok: false, reason: "unknown_kid" };
  let good = false;
  try {
    good = edVerify(null, Buffer.from(`${h}.${b}`), key, Buffer.from(s, "base64url"));
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (!good) return { ok: false, reason: "bad_signature" };
  let payload: unknown;
  try {
    payload = decode(b);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isObj(payload)) return { ok: false, reason: "malformed" };
  if (payload.aud !== audience) return { ok: false, reason: "wrong_audience" };
  if (payload.iss !== ring.issuer) return { ok: false, reason: "wrong_issuer" };
  return { ok: true, payload, kid: header.kid };
}

function timing(c: { iat: number; exp?: number; nbf?: number }, ring: Ring, now: number, ttlCeiling: boolean): Rejection | null {
  const skew = ring.skewSeconds ?? 30;
  if (c.exp !== undefined && c.exp + skew <= now) return "expired";
  if (c.nbf !== undefined && c.nbf - skew > now) return "not_yet_valid";
  if (c.iat - skew > now) return "not_yet_valid";
  if (ttlCeiling && c.exp !== undefined && c.exp - c.iat > Math.min(ring.maxTtlSeconds ?? MAX_TTL, MAX_TTL)) return "ttl_too_long";
  return null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function verifyJoinToken(token: string, ring: Ring, opts: { now?: number; room?: string } = {}): Verified<JoinClaims> {
  const base = verifyCompact(token, ring, "media");
  if (!base.ok) return base;
  if (!validJoinClaims(base.payload)) return { ok: false, reason: "bad_claims" };
  const claims = base.payload as unknown as JoinClaims;
  const t = timing(claims, ring, opts.now ?? nowSeconds(), true);
  if (t) return { ok: false, reason: t };
  if (opts.room !== undefined && claims.room !== opts.room) return { ok: false, reason: "wrong_room" };
  if (!grantsValidForKind(claims.grants, claims.kind)) return { ok: false, reason: "bad_claims" };
  if (claims.kind === "human" && claims.transport !== "webrtc") return { ok: false, reason: "bad_transport" };
  return { ok: true, claims, kid: base.kid };
}

export function verifyControlToken(token: string, ring: Ring, opts: { now?: number } = {}): Verified<ControlClaims> {
  const base = verifyCompact(token, ring, "control");
  if (!base.ok) return base;
  if (!validControlClaims(base.payload)) return { ok: false, reason: "bad_claims" };
  const claims = base.payload as unknown as ControlClaims;
  const t = timing(claims, ring, opts.now ?? nowSeconds(), true);
  return t ? { ok: false, reason: t } : { ok: true, claims, kid: base.kid };
}

/** A WHIP bearer: same ring and issuer; long-lived, so no TTL ceiling and `exp` only when present. Not single use. */
export function verifyWhipToken(token: string, ring: Ring, opts: { now?: number } = {}): Verified<WhipClaims> {
  const base = verifyCompact(token, ring, "whip");
  if (!base.ok) return base;
  if (!validWhipClaims(base.payload)) return { ok: false, reason: "bad_claims" };
  const claims = base.payload as unknown as WhipClaims;
  const t = timing(claims, ring, opts.now ?? nowSeconds(), false);
  return t ? { ok: false, reason: t } : { ok: true, claims, kid: base.kid };
}

/** Single use: a jti is honoured once until it expires. In memory: the open-source media plane is one process. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  private sweptAt = 0;

  /** "fresh" the first time, "replayed" after. */
  consume(jti: string, expiresAtSeconds: number, now = Date.now()): "fresh" | "replayed" {
    if (now - this.sweptAt > 60_000) {
      this.sweptAt = now;
      for (const [k, until] of this.seen) if (until < now) this.seen.delete(k);
    }
    const until = this.seen.get(jti);
    if (until !== undefined && until >= now) return "replayed";
    // Kept past exp + skew, so a token can never verify again after it is forgotten.
    this.seen.set(jti, expiresAtSeconds * 1000 + 60_000);
    return "fresh";
  }
}
