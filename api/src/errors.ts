// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { components } from "./generated-error.js";

export type ErrorCode = components["code"];

/** Thrown in handlers; rendered in the spec's error shape. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function errorBody(code: string, message: string, requestId: string, details?: Record<string, unknown>) {
  return { error: { code, message, request_id: requestId, ...(details ? { details } : {}) } };
}
