// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Footage encrypted at rest with keys the server holds (ADR 0066). Each
// account has a random data key, stored only wrapped by the instance's
// MEDIA_ENCRYPTION_KEY; deleting it makes the account's footage unreadable,
// backups included. From it come:
//   - per camera, the AES-128 key its recording segments are encrypted with
//     (HLS AES-128, so players decrypt and playback links stay direct), and
//     each segment's IV from its object key;
//   - for snapshots and exports, AES-256-GCM objects: "SPE1" | version (u32) |
//     nonce (12) | ciphertext | tag (16), with the account id as associated data.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { DataAccess } from "./data/access.js";

const MAGIC = Buffer.from("SPE1");
const WRAP_PREFIX = "wk:v1:";

/** Wraps and unwraps data keys with the master key (a KMS can stand in for it). */
export interface KeyWrapper {
  wrap(dataKey: Buffer, accountId: string): Promise<string>;
  unwrap(wrapped: string, accountId: string): Promise<Buffer>;
}

/** The master key from MEDIA_ENCRYPTION_KEY (at least 32 characters), AES-256-GCM. */
export function envKeyWrapper(keyMaterial: string): KeyWrapper {
  if (!keyMaterial || keyMaterial.length < 32) throw new Error("MEDIA_ENCRYPTION_KEY must be at least 32 characters");
  const kek = createHash("sha256").update("senseplane media keys\0").update(keyMaterial).digest();
  return {
    async wrap(dataKey, accountId) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", kek, iv);
      c.setAAD(Buffer.from(accountId));
      const body = Buffer.concat([c.update(dataKey), c.final()]);
      return WRAP_PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
    },
    async unwrap(wrapped, accountId) {
      if (!wrapped.startsWith(WRAP_PREFIX)) throw new Error("unknown wrapped key format");
      const raw = Buffer.from(wrapped.slice(WRAP_PREFIX.length), "base64url");
      const d = createDecipheriv("aes-256-gcm", kek, raw.subarray(0, 12));
      d.setAAD(Buffer.from(accountId));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
    },
  };
}

export const newMediaKey = () => randomBytes(32).toString("base64url");

/** An account's data key, by version. */
export interface DataKey {
  version: number;
  key: Buffer;
}

/** Per-camera AES-128 key for recording segments. */
export const segmentKey = (dk: Buffer, sourceId: string) => Buffer.from(hkdfSync("sha256", dk, Buffer.alloc(0), `senseplane segments v1:${sourceId}`, 16));

/** A segment's IV, from its object key (the media plane is told it; the API stores it with the segment). */
export const segmentIV = (dk: Buffer, objectKey: string) => createHmac("sha256", dk).update(`iv:${objectKey}`).digest().subarray(0, 16);

const objectKey = (dk: Buffer) => Buffer.from(hkdfSync("sha256", dk, Buffer.alloc(0), "senseplane objects v1", 32));

export interface KeyRing {
  /** The account's current key, made on first use. */
  current(accountId: string): Promise<DataKey>;
  /** A version of the account's key; undefined when it no longer exists (the account was deleted). */
  get(accountId: string, version: number): Promise<Buffer | undefined>;
  /** Forgets the cached keys of an account (after deleting them). */
  forget(accountId: string): void;
}

export function createKeyRing(data: DataAccess, wrapper: KeyWrapper): KeyRing {
  const cache = new Map<string, Map<number, Buffer>>();
  const currentOf = new Map<string, number>();
  // Kept for a while, then read again: a key rotated or deleted by another process is seen within this.
  const loadedAt = new Map<string, number>();
  const TTL_MS = 10 * 60_000;
  const fresh = (accountId: string) => Date.now() - (loadedAt.get(accountId) ?? 0) < TTL_MS;
  const remember = (accountId: string, version: number, key: Buffer) => {
    let m = cache.get(accountId);
    if (!m) {
      if (cache.size > 5000) cache.clear();
      m = new Map();
      cache.set(accountId, m);
    }
    m.set(version, key);
  };
  const load = async (accountId: string) => {
    const rows = await data.withAccount(accountId, (s) => s.db.selectFrom("account_keys").select(["version", "wrapped"]).where("account_id", "=", accountId).orderBy("version", "desc").execute());
    cache.delete(accountId);
    currentOf.delete(accountId);
    for (const r of rows) remember(accountId, r.version, await wrapper.unwrap(r.wrapped, accountId));
    if (rows[0]) currentOf.set(accountId, rows[0].version);
    loadedAt.set(accountId, Date.now());
    return rows.length;
  };
  return {
    async current(accountId) {
      let v = fresh(accountId) ? currentOf.get(accountId) : undefined;
      if (v === undefined && (await load(accountId)) === 0) {
        const key = randomBytes(32);
        const wrapped = await wrapper.wrap(key, accountId);
        // Two processes may race to make the first key: one insert wins, both read it back.
        await data.withAccount(accountId, (s) => s.db.insertInto("account_keys").values({ account_id: accountId, version: 1, wrapped })
          .onConflict((oc) => oc.columns(["account_id", "version"]).doNothing()).execute());
        await load(accountId);
      }
      v = currentOf.get(accountId)!;
      return { version: v, key: cache.get(accountId)!.get(v)! };
    },
    async get(accountId, version) {
      const hit = fresh(accountId) ? cache.get(accountId)?.get(version) : undefined;
      if (hit) return hit;
      await load(accountId);
      return cache.get(accountId)?.get(version);
    },
    forget(accountId) {
      cache.delete(accountId);
      currentOf.delete(accountId);
      loadedAt.delete(accountId);
    },
  };
}

/** Encrypts an object (snapshot, export) with the account's current key. */
export async function sealObject(ring: KeyRing, accountId: string, plain: Uint8Array): Promise<Buffer> {
  const dk = await ring.current(accountId);
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", objectKey(dk.key), nonce);
  c.setAAD(Buffer.from(accountId));
  const body = Buffer.concat([c.update(plain), c.final()]);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(dk.version);
  return Buffer.concat([MAGIC, version, nonce, body, c.getAuthTag()]);
}

export const isSealed = (b: Uint8Array) => b.length >= 36 && Buffer.from(b.subarray(0, 4)).equals(MAGIC);

/** Decrypts a sealed object; objects stored before encryption come back as they are. */
export async function openObject(ring: KeyRing, accountId: string, stored: Buffer): Promise<Buffer> {
  if (!isSealed(stored)) return stored;
  const dk = await ring.get(accountId, stored.readUInt32BE(4));
  if (!dk) throw new Error("this object's key no longer exists");
  const d = createDecipheriv("aes-256-gcm", objectKey(dk), stored.subarray(8, 20));
  d.setAAD(Buffer.from(accountId));
  d.setAuthTag(stored.subarray(stored.length - 16));
  return Buffer.concat([d.update(stored.subarray(20, stored.length - 16)), d.final()]);
}

/** Encrypts a recording segment as HLS AES-128 does (CBC, PKCS#7): what the media plane does before upload. */
export function encryptSegment(key: Buffer, iv: Buffer, plain: Uint8Array): Buffer {
  const c = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([c.update(plain), c.final()]);
}

export function decryptSegment(key: Buffer, iv: Buffer, sealed: Uint8Array): Buffer {
  const d = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([d.update(sealed), d.final()]);
}
