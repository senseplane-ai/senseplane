// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Preload: `node --import @senseplane/telemetry/register dist/server.js`.
// Does nothing unless OTEL_EXPORTER_OTLP_ENDPOINT is set (ADR 0033).
import { register } from "node:module";
import { telemetryEnabled } from "./index.js";

if (telemetryEnabled()) {
  // ESM loader hook so imported packages (pg, fastify, undici...) can be instrumented.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  const { startTelemetry } = await import("./sdk.js");
  startTelemetry();
}
