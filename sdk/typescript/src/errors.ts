// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { components } from "./generated/schema.js";

export type ErrorCode = components["schemas"]["Error"]["error"]["code"];

/** Thrown for any non-2xx API response. */
export class SenseplaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "unknown",
    message: string,
    readonly requestId?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SenseplaneError";
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}
