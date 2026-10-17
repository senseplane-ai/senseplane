// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// The OpenTelemetry Node SDK, configured from the standard OTEL_* variables
// (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_SERVICE_NAME, OTEL_TRACES_SAMPLER...).
// Traces only: metrics stay on each service's Prometheus /metrics, which the
// Collector scrapes (docs/observability.md).
import { FastifyOtelInstrumentation } from "@fastify/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { NodeSDK } from "@opentelemetry/sdk-node";

const QUIET_PATHS = /^\/(metrics|healthz)(\?|$)/;
// Media callbacks (a camera's frames, about one a second) are traced only when the media plane sampled them.
const MEDIA_CALLBACKS = /^\/internal\/media\/callbacks(\?|$)/;
const quiet = (url: string | undefined, traceparent: unknown) => QUIET_PATHS.test(url ?? "") || (MEDIA_CALLBACKS.test(url ?? "") && !traceparent);

/** Webhook deliveries go to other people's servers: no client span, and no traceparent leaks to them. */
export function isWebhookDelivery(headers: string | (string | string[])[]): boolean {
  const text = Array.isArray(headers) ? headers.flat().join("\n") : headers;
  return text.toLowerCase().includes("senseplane-delivery");
}

export function startTelemetry(): NodeSDK {
  process.env.OTEL_METRICS_EXPORTER ??= "none";
  process.env.OTEL_LOGS_EXPORTER ??= "none";
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => quiet(req.url, req.headers.traceparent),
      }),
      new UndiciInstrumentation({ ignoreRequestHook: (req) => isWebhookDelivery(req.headers) }),
      // Query text only; parameter values (which may hold personal data) are never recorded.
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      new FastifyOtelInstrumentation({ registerOnInitialization: true, ignorePaths: (r) => quiet(r.url, (r as { headers?: Record<string, unknown> }).headers?.traceparent) }),
    ],
  });
  sdk.start();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void sdk.shutdown().catch(() => {}));
  return sdk;
}
