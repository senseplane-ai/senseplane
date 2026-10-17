// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0
// Error codes from spec/schemas/error.json.

export interface components {
  code:
    | "unauthorized"
    | "forbidden"
    | "forbidden_sense"
    | "not_found"
    | "validation_failed"
    | "quota_exceeded"
    | "allowance_exhausted"
    | "rate_limited"
    | "needs_zone"
    | "unsupported_codec"
    | "resolution_not_in_plan"
    | "source_limit_reached"
    | "not_implemented"
    | "service_unavailable"
    | "internal"
    | "idempotency_key_reused"
    | "signup_refused"
    | "forbidden_role"
    | "invite_invalid"
    | "conflict"
    | "feature_not_available"
    | "limit_reached";
}
