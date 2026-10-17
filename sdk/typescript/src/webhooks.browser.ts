// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Browser build: webhook verification needs the signing secret, so it only
// runs server-side. Swapped in through the package.json "browser" field.
import type { Event } from "./webhooks.js";

const serverOnly = (): never => {
  throw new Error("Webhook signing and verification are server-side only");
};
export type { Event };
export const signWebhook: (body: string, secret: string, timestamp?: number) => string = serverOnly;
export const verifyWebhook: (
  rawBody: string,
  signatureHeader: string | string[] | undefined,
  secret: string,
  options?: { toleranceSeconds?: number; now?: number },
) => Event = serverOnly;
