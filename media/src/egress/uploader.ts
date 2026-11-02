// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Where a feed's objects go: the caller's bucket, named per request. With a
// presign-callback destination (preferred) the egress asks for a presigned
// PUT per object and holds no credential at all; with an s3 destination the
// short-lived credentials live in this process's memory only, refreshed
// through the callback a minute before they expire, and never logged.
import { createCipheriv } from "node:crypto";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FeedCallback } from "./callback.js";
import type { Credentials, Destination } from "./validate.js";

/** How an object was stored: encrypted with the key the callback gave for it (HLS AES-128), or as it was. */
export interface Stored {
  bytes: number;
  encryption?: { method: "aes-128"; key_id: string; iv: string };
}

export interface Uploader {
  put(key: string, body: Buffer, contentType: string): Promise<Stored>;
}

const REFRESH_BEFORE_MS = 60_000;

export function createUploader(destination: Destination, callback: FeedCallback, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Uploader {
  const doFetch = o.fetch ?? fetch;
  if (destination.type === "presign-callback") {
    return {
      async put(key, body, contentType) {
        // Offer to encrypt; a caller that holds keys answers with one for this object (spec/media callbacks.json).
        const answer = await callback.request<{ url?: unknown; headers?: unknown; encryption?: unknown }>("upload_url", { key, content_type: contentType, bytes: body.length, encryption: ["aes-128"] });
        if (typeof answer?.url !== "string" || !/^https?:\/\//i.test(answer.url)) throw new Error("the callback did not answer upload_url with an http(s) url");
        const extra = answer.headers && typeof answer.headers === "object"
          ? Object.fromEntries(Object.entries(answer.headers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
          : {};
        const enc = segmentEncryption(answer.encryption);
        const stored = enc ? encryptSegment(body, enc.key, enc.iv) : body;
        const res = await doFetch(answer.url, {
          method: "PUT",
          headers: { "content-type": contentType, ...extra },
          body: new Uint8Array(stored),
          signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
        });
        await res.arrayBuffer().catch(() => undefined);
        // The URL is a credential: the error names the key, never the URL.
        if (!res.ok) throw new Error(`the presigned PUT for ${key} answered ${res.status}`);
        return enc ? { bytes: stored.length, encryption: { method: "aes-128", key_id: enc.keyId, iv: enc.iv.toString("hex") } } : { bytes: stored.length };
      },
    };
  }
  let creds: Credentials = destination.credentials;
  const client = (c: Credentials) =>
    new S3Client({
      endpoint: destination.endpoint, region: destination.region, forcePathStyle: true,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}) },
    });
  let s3 = client(creds);
  return {
    async put(key, body, contentType) {
      const expires = creds.expiresAt ? Date.parse(creds.expiresAt) : Number.POSITIVE_INFINITY;
      if (expires - Date.now() <= REFRESH_BEFORE_MS) {
        const next = (await callback.request<{ credentials?: Credentials }>("credentials", {})).credentials;
        if (!next?.accessKeyId || !next.secretAccessKey) throw new Error("the callback did not answer credentials");
        creds = next;
        s3 = client(next);
      }
      await s3.send(new PutObjectCommand({ Bucket: destination.bucket, Key: key, Body: body, ContentType: contentType }));
      return { bytes: body.length };
    },
  };
}

/** A valid encryption answer: AES-128 with a 16-byte key and IV, and the key's id to report back. */
function segmentEncryption(x: unknown): { key: Buffer; iv: Buffer; keyId: string } | undefined {
  if (!x || typeof x !== "object") return undefined;
  const e = x as { method?: unknown; key?: unknown; iv?: unknown; key_id?: unknown };
  if (e.method !== "aes-128" || typeof e.key !== "string" || typeof e.iv !== "string" || typeof e.key_id !== "string") {
    throw new Error("the callback answered upload_url with an encryption this media plane doesn't know");
  }
  const key = Buffer.from(e.key, "base64");
  const iv = Buffer.from(e.iv, "hex");
  if (key.length !== 16 || iv.length !== 16) throw new Error("the callback answered upload_url with a malformed key or IV");
  return { key, iv, keyId: e.key_id };
}

/** HLS AES-128: the whole segment in AES-128-CBC with PKCS#7 padding (RFC 8216 5.2), as players decrypt it. */
function encryptSegment(body: Buffer, key: Buffer, iv: Buffer): Buffer {
  const c = createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([c.update(body), c.final()]);
}
