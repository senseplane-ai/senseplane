// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import { createHmac, timingSafeEqual } from "node:crypto";
import type { components } from "./generated/schema.js";
import { WebhookVerificationError } from "./errors.js";

export type Event = components["schemas"]["Event"];

const DEFAULT_TOLERANCE_S = 300;

/** Computes the `Senseplane-Signature` header value for a payload. */
export function signWebhook(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Verifies a webhook delivery and returns the parsed event.
 * Throws WebhookVerificationError on a bad signature or a stale timestamp.
 */
export function verifyWebhook(
  rawBody: string | Buffer,
  signatureHeader: string | string[] | undefined,
  secret: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): Event {
  const header = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!header) throw new WebhookVerificationError("missing Senseplane-Signature header");
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1) throw new WebhookVerificationError("malformed signature header");
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_S)) {
    throw new WebhookVerificationError("timestamp outside tolerance");
  }
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"), "hex");
  const given = Buffer.from(v1, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new WebhookVerificationError("signature mismatch");
  }
  return JSON.parse(body) as Event;
}
