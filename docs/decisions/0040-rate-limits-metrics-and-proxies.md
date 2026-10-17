# 40. Rate limits, metrics and trusted proxies

Date: 2026-10-17 · Status: accepted

## Decision
- **Rate limits** (fixed one-minute windows, per process):
  - API: per key `RATE_LIMIT_PER_MINUTE` (600); per key for watch compiles,
    ask and memory search `RATE_LIMIT_EXPENSIVE_PER_MINUTE` (30); per IP for
    unauthenticated routes `RATE_LIMIT_ANONYMOUS_PER_MINUTE` (600). `0` turns
    a bucket off. Over the limit: 429 `rate_limited` with `Retry-After`.
  - MCP: per bearer on `/mcp` (`RATE_LIMIT_PER_MINUTE`), per IP on `/oauth/*`
    (`RATE_LIMIT_OAUTH_PER_MINUTE`, 60).
- **/metrics** needs `Authorization: Bearer $METRICS_TOKEN` when set; without
  it, it is served in development only. The API's internal listener always
  serves it.
- **Client IPs:** `TRUSTED_PROXIES` (CIDRs) or `TRUST_PROXY=<hops>`; the old
  "trust every hop" setting is gone, so a client can't spoof
  `X-Forwarded-For`.
- **Demo limits** are re-checked and the session recorded under one Postgres
  advisory lock, so a burst can't pass the per-IP or concurrency limits. The
  local website origin is a default only outside production.
- **Logs** replace media tokens in URL paths with `<token>`.

## Consequences
Behind a load balancer the effective limit is the per-process limit times the
number of replicas. A shared store (e.g. Redis) can replace the in-memory
windows later without changing the API.
