// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Outbound HTTP for webhooks, hardened against server-side request forgery.
//
// The destination is resolved at delivery time, inside the socket's own DNS
// lookup, and every resolved address is checked against non-public ranges.
// The connection then uses exactly the address that passed the check, so a
// DNS record that changes between check and connect (rebinding) can't reach
// an internal host. Errors are reduced to coarse categories so the delivery
// log can't be used as a port or host scanner.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { untraced } from "@senseplane/telemetry";

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, bits, "ipv6");

/** Embedded IPv4 in IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible and NAT64 (64:ff9b::/96) addresses. */
function embeddedV4(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const a = parseInt(hex[1]!, 16);
    const b = parseInt(hex[2]!, 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return undefined;
}

/** True when an IP address is not a public unicast address (private, loopback, link-local, CGNAT, metadata, ULA, multicast, reserved). */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) {
    const v4 = embeddedV4(ip);
    if (v4) return blocked.check(v4, "ipv4");
    return blocked.check(ip, "ipv6");
  }
  return true;
}

export interface EgressPolicy {
  /** Allow private and internal destinations (self-hosters whose receivers live on the same network). */
  allowPrivate: boolean;
  /** Hostnames allowed even when they resolve to private addresses. */
  allowedHosts: string[];
}

export function egressPolicyFromEnv(env = process.env): EgressPolicy {
  return {
    allowPrivate: env.WEBHOOK_ALLOW_PRIVATE === "1",
    allowedHosts: (env.WEBHOOK_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  };
}

function hostAllowed(host: string, policy: EgressPolicy) {
  return policy.allowPrivate || policy.allowedHosts.includes(host.toLowerCase());
}

/** Why a URL can't be a webhook target, or undefined when it may be (subject to the delivery-time DNS check). */
export function webhookUrlProblem(raw: string, opts: { production: boolean; policy: EgressPolicy }): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url must be an absolute URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "url must be http(s)";
  if (url.username || url.password) return "url must not contain credentials";
  if (opts.production && url.protocol !== "https:") return "webhook URLs must use https";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (hostAllowed(host, opts.policy)) return undefined;
  if (isIP(host)) return isBlockedAddress(host) ? "webhook URLs must be public" : undefined;
  // Single-label names (compose service names such as "media" or "valkey") and local suffixes never resolve publicly.
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|lan|home|localdomain|home\.arpa)$/i.test(host)) return "webhook URLs must be public";
  return undefined;
}

export type EgressErrorKind = "blocked_destination" | "dns_failure" | "connection_failed" | "timeout" | "tls_error";

export class EgressError extends Error {
  constructor(public kind: EgressErrorKind) {
    super(kind);
  }
}

/** A DNS lookup that refuses non-public addresses, used as the socket's own lookup so the vetted address is the one connected to. */
export function guardedLookup(policy: EgressPolicy) {
  return (hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = addresses as LookupAddress[];
      if (!list.length) return callback(Object.assign(new Error("no address"), { code: "ENOTFOUND" }), "", 0);
      if (!hostAllowed(hostname, policy) && list.some((a) => isBlockedAddress(a.address))) {
        return callback(Object.assign(new Error("blocked destination"), { code: "EBLOCKED" }), "", 0);
      }
      const all = (options as { all?: boolean }).all;
      if (all) return callback(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

function classify(err: NodeJS.ErrnoException): EgressErrorKind {
  const code = err.code ?? "";
  if (code === "EBLOCKED") return "blocked_destination";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") return "dns_failure";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
  if (/CERT|SSL|TLS/i.test(code) || /certificate|tls|ssl/i.test(err.message)) return "tls_error";
  return "connection_failed";
}

export interface EgressRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
}

/**
 * Sends one request without following redirects. Resolves with the HTTP status
 * (a 3xx is returned as-is, never followed); rejects with an EgressError.
 */
export function guardedRequest(rawUrl: string, req: EgressRequest, policy: EgressPolicy): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return reject(new EgressError("blocked_destination"));
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" && url.protocol !== "http:") return reject(new EgressError("blocked_destination"));
    if (isIP(host) && isBlockedAddress(host) && !hostAllowed(host, policy)) return reject(new EgressError("blocked_destination"));
    if (!isIP(host) && webhookUrlProblem(rawUrl, { production: false, policy })) return reject(new EgressError("blocked_destination"));
    const mod = url.protocol === "https:" ? https : http;
    const timeout = req.timeoutMs ?? 10_000;
    // Tracing is suppressed for webhook delivery, so no traceparent reaches webhook receivers (observability ADR).
    const r = untraced(() => mod.request(
      url,
      {
        method: req.method,
        headers: { ...req.headers, "content-length": Buffer.byteLength(req.body).toString() },
        lookup: guardedLookup(policy) as never,
        timeout,
        agent: false,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        res.on("error", () => resolve({ status: res.statusCode ?? 0 }));
      },
    ));
    const timer = setTimeout(() => r.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), timeout);
    r.on("timeout", () => r.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    r.on("error", (e) => {
      clearTimeout(timer);
      reject(new EgressError(classify(e as NodeJS.ErrnoException)));
    });
    r.on("close", () => clearTimeout(timer));
    r.end(req.body);
  });
}

/** Coarse, non-revealing error text stored in the delivery log. */
export function deliveryErrorText(e: unknown, status?: number): string {
  if (status !== undefined) return status >= 300 && status < 400 ? "HTTP 3xx (redirects are not followed)" : `HTTP ${status}`;
  if (e instanceof EgressError) {
    return {
      blocked_destination: "destination not allowed",
      dns_failure: "DNS lookup failed",
      connection_failed: "connection failed",
      timeout: "timeout",
      tls_error: "TLS error",
    }[e.kind];
  }
  return "connection failed";
}
