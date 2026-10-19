// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { CopyObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StorageConfig {
  endpoint?: string;
  /** Endpoint browsers can reach, for presigned URLs; unset = stream through the API. */
  publicEndpoint?: string;
  /** Endpoint the media plane PUTs segments to (presigned, ADR 0049); unset = `endpoint`. A remote media plane needs one it can reach. */
  uploadEndpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
}

export interface ObjectStorage {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  copy(fromKey: string, toKey: string): Promise<void>;
  deleteMany(keys: string[]): Promise<number>;
  /** Deletes every object under a prefix; returns how many. */
  deletePrefix(prefix: string): Promise<number>;
  /** A presigned PUT for one object, for the media plane's feed egress (spec/media upload_url). */
  presignPut(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  /** Presigned GET URL when a public endpoint is configured, otherwise undefined. */
  presign(key: string, expiresInSeconds: number): Promise<string | undefined>;
  get(key: string): Promise<{ body: ReadableStream | NodeJS.ReadableStream; length?: number; contentType?: string }>;
}

export function storageConfigFromEnv(env = process.env): StorageConfig {
  return {
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    uploadEndpoint: env.S3_UPLOAD_ENDPOINT,
    region: env.S3_REGION ?? "us-east-1",
    bucket: env.S3_BUCKET ?? "senseplane",
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true") === "true",
  };
}

export function createObjectStorage(cfg: StorageConfig): ObjectStorage {
  const credentials = cfg.accessKeyId && cfg.secretAccessKey ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } : undefined;
  const client = new S3Client({ endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle, credentials });
  const presigner = cfg.publicEndpoint
    ? new S3Client({ endpoint: cfg.publicEndpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle, credentials })
    : undefined;
  const uploader = cfg.uploadEndpoint && cfg.uploadEndpoint !== cfg.endpoint
    ? new S3Client({ endpoint: cfg.uploadEndpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle, credentials })
    : client;
  const Bucket = cfg.bucket;
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async copy(fromKey, toKey) {
      await client.send(new CopyObjectCommand({ Bucket, Key: toKey, CopySource: `${Bucket}/${encodeURI(fromKey)}` }));
    },
    async deleteMany(keys) {
      let deleted = 0;
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        const res = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
        if (res.Errors?.length) throw new Error(`delete failed for ${res.Errors.length} objects: ${res.Errors[0]?.Message}`);
        deleted += batch.length;
      }
      return deleted;
    },
    async deletePrefix(prefix) {
      let total = 0;
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        const keys = (page.Contents ?? []).map((o) => o.Key!).filter(Boolean);
        if (keys.length) total += await this.deleteMany(keys);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return total;
    },
    async presignPut(key, contentType, expiresIn) {
      return getSignedUrl(uploader, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), { expiresIn });
    },
    async presign(key, expiresIn) {
      if (!presigner) return undefined;
      return getSignedUrl(presigner, new GetObjectCommand({ Bucket, Key: key }), { expiresIn });
    },
    async get(key) {
      const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      return { body: res.Body as NodeJS.ReadableStream, length: res.ContentLength, contentType: res.ContentType };
    },
  };
}

/** Reads a whole object into memory (snapshots and other small files). */
export async function readObject(storage: ObjectStorage, key: string): Promise<Buffer> {
  const { body } = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}
