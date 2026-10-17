// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type { DataAccess } from "./data/access.js";

export interface UsageRecord {
  accountId: string;
  kind: "recording_seconds" | "storage_byte_days" | "frames_analysed" | "vlm_calls";
  quantity: number;
  at: Date;
}

export type UsageMeter = "ai_checks" | "camera_minutes" | "storage_gb" | "live_view_minutes";

/** A cap on one meter over a UTC day or month (ADR 0025, 0029). */
export interface UsageLimit {
  meter: UsageMeter;
  period: "day" | "month";
  limit: number;
  /**
   * "hard" (default): stop at the limit (watches pause, ask/watches answer
   * `allowance_exhausted`, cameras are disconnected and refused).
   * "notify": usage carries on past the limit; only onUsageLimit fires.
   */
  enforcement?: "hard" | "notify";
}

export interface Quota {
  /** Registered sources (null: no limit). */
  maxSources: number | null;
  /** Sources streaming at once (null: no limit). */
  maxActiveSources?: number | null;
  /** Usage caps; none by default. */
  usageLimits?: UsageLimit[];
  /** Maximum raw retention in days; null means no limit (self-host). ADR 0016. */
  maxRetentionDays: number | null;
  /** Storage cap in bytes for fill-mode retention when the account sets none (ADR 0032); null or unset: no cap. */
  storageCapBytes?: number | null;
  /** Highest recording resolution (ADR 0022); 720p unless the quota says 1080p. */
  maxResolution?: "720p" | "1080p";
  /**
   * Live view (ADR 0042). Unset means enabled; false answers `POST /v1/sources/{id}/live`
   * with 403 `feature_not_available`. Viewing time is the `live_view_minutes` meter, so
   * an allowance is a `usageLimits` entry for it.
   */
  liveView?: boolean;
  /** People watching live at once across the account (null or unset: no limit); over it, 429 `limit_reached`. */
  maxLiveViewers?: number | null;
  /** A display name for the account's plan, shown by the console (`GET /v1/account` `plan_label`). */
  planLabel?: string | null;
}

export interface AuditEntry {
  accountId?: string;
  actor: string;
  action: string;
  target: string;
  status?: number;
  details?: Record<string, unknown>;
}

export interface AuditLog {
  write(entry: AuditEntry): Promise<void>;
}

/** A sign-up attempt, passed to `onSignup` before any account exists (ADR 0031). */
export interface SignupRequest {
  method: "password" | "google" | "github";
  /** Lower-cased email address. */
  email: string;
  /** True when the identity provider says the address is verified. */
  emailVerified: boolean;
  provider?: {
    name: "google" | "github";
    /** The provider's stable user id (Google `sub`, GitHub numeric id). */
    id: string;
    login?: string;
    /** When the provider account was created, if the provider says (GitHub does). */
    createdAt?: string;
    publicRepos?: number;
    followers?: number;
  };
  ip: string;
  userAgent?: string;
  /** First-party browser token the console keeps, if any. */
  deviceToken?: string;
  /** Token from the sign-up challenge widget, if one is configured. */
  challengeToken?: string;
}

/** Allow (optionally with a plan label) or refuse a sign-up. */
export type SignupDecision = { allow: true; plan?: string } | { allow: false; message: string };

export interface ModuleContext {
  data: DataAccess;
  audit: AuditLog;
  auth: { requireRole(role: "operator"): preHandlerHookHandler };
}

/**
 * An extension plugged into createApi (for example administration or abuse
 * tooling). Stable interface; semver (ADR 0007).
 */
export interface ApiModule {
  name: string;
  /** Routes on the public listener. */
  publicRoutes?(app: FastifyInstance, ctx: ModuleContext): void | Promise<void>;
  /** Routes on the internal-only listener (requires internalPort). */
  internalRoutes?(app: FastifyInstance, ctx: ModuleContext): void | Promise<void>;
  /** Receives every usage record, e.g. to feed an external metering system. */
  onUsage?(record: UsageRecord): Promise<void>;
  /** Overrides the default quota for an account, e.g. from a plan. */
  quotaFor?(accountId: string): Promise<Quota | undefined>;
  /** Receives every audit entry (after it is stored). */
  onAudit?(entry: AuditEntry): Promise<void>;
  /**
   * Decides a sign-up before the account is created. The first module that
   * refuses wins (403 `signup_refused`); the first plan label returned is stored
   * on the account for the quota provider. Undefined: no opinion.
   */
  onSignup?(request: SignupRequest): Promise<SignupDecision | undefined>;
  /** Called after a sign-up created an account (e.g. to record linking signals). */
  onAccountCreated?(accountId: string, request: SignupRequest, plan: string | undefined): Promise<void>;
  /** Called when an account goes over a usage limit, hard or notify (e.g. for alerts). */
  onUsageLimit?(accountId: string, meter: UsageMeter, used: number, limit: number): Promise<void>;
}
