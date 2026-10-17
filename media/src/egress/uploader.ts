// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Where a feed's objects go: the caller's bucket, named per request. With a
// presign-callback destination (preferred) the egress asks for a presigned
// PUT per object and holds no credential at all; with an s3 destination the
// short-lived credentials live in this process's memory only, refreshed
// through the callback a minute before they expire, and never logged.
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FeedCallback } from "./callback.js";
import type { Credentials, Destination } from "./validate.js";

export interface Uploader {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
}

const REFRESH_BEFORE_MS = 60_000;

export function createUploader(destination: Destination, callback: FeedCallback, o: { fetch?: typeof fetch; timeoutMs?: number } = {}): Uploader {
  const doFetch = o.fetch ?? fetch;
  if (destination.type === "presign-callback") {
    return {
      async put(key, body, contentType) {
        const answer = await callback.request<{ url?: unknown; headers?: unknown }>("upload_url", { key, content_type: contentType, bytes: body.length });
        if (typeof answer?.url !== "string" || !/^https?:\/\//i.test(answer.url)) throw new Error("the callback did not answer upload_url with an http(s) url");
        const extra = answer.headers && typeof answer.headers === "object"
          ? Object.fromEntries(Object.entries(answer.headers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
          : {};
        const res = await doFetch(answer.url, {
          method: "PUT",
          headers: { "content-type": contentType, ...extra },
          body: new Uint8Array(body),
          signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
        });
        await res.arrayBuffer().catch(() => undefined);
        // The URL is a credential: the error names the key, never the URL.
        if (!res.ok) throw new Error(`the presigned PUT for ${key} answered ${res.status}`);
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
    },
  };
}
