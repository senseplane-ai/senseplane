// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { Redis } from "ioredis";
import { valkeyGrantStore } from "./grant-store.js";
import { createMcpService } from "./service.js";

// With VALKEY_URL set, redeemed OAuth codes are recorded in Valkey so any
// number of MCP instances agree on single use.
const valkey = process.env.VALKEY_URL ? new Redis(process.env.VALKEY_URL, { connectionName: "senseplane-mcp" }) : undefined;
const grants = valkey ? valkeyGrantStore(valkey) : undefined;

const app = createMcpService({ grants });
await app.listen({ port: Number(process.env.PORT ?? 8060), host: "0.0.0.0" });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => valkey?.quit());
  });
