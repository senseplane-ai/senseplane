// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Open-source entry point: the API with no extra modules.
import { createApi } from "./createApi.js";
import { assertNoDefaultCredentials } from "./ingest.js";
import { storageConfigFromEnv } from "./storage.js";
import { migrateToLatest } from "./migrate.js";

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

assertNoDefaultCredentials();
if (process.env.MIGRATION_DATABASE_URL) await migrateToLatest(process.env.MIGRATION_DATABASE_URL);

const api = await createApi({
  database: env("DATABASE_URL"),
  // The media plane (spec/media, ADR 0049): a local media server and a remote media plane differ only in these values.
  media: {
    control: env("MEDIA_CONTROL_URL"),
    ...(process.env.MEDIA_PUBLIC_URL ? { publicUrl: process.env.MEDIA_PUBLIC_URL } : {}),
    ...(process.env.API_CALLBACK_URL ? { callbackUrl: process.env.API_CALLBACK_URL } : {}),
  },
  captureUrl: env("CAPTURE_URL"),
  valkeyUrl: process.env.VALKEY_URL,
  apiPublicUrl: process.env.API_PUBLIC_URL,
  storage: process.env.S3_ENDPOINT || process.env.S3_BUCKET ? storageConfigFromEnv() : undefined,
  sweepIntervalSeconds: process.env.RETENTION_SWEEP_SECONDS ? Number(process.env.RETENTION_SWEEP_SECONDS) : undefined,
  // API_WORKERS=false: this process only serves requests; background work runs in the ones that have it on (ADR 0058).
  workers: process.env.API_WORKERS !== "false",
  corsOrigins: process.env.CORS_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
});
await api.listen({ port: Number(process.env.PORT ?? 8080) });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void api.close());
