# 35. Webhook egress guard and infrastructure defaults

Date: 2026-10-17 · Status: accepted · The NATS parts are superseded by ADR 0051 (Valkey with a password)

## Context
Webhook URLs were checked with a hostname regex once, at creation, and only in
production. DNS names pointing at internal addresses, single-label compose
names and IPv6-mapped forms got through, and stored fetch errors turned the
delivery log into a scanner. The compose bundle published Postgres, NATS (no
auth) and object storage on all interfaces with known credentials.

## Decision
**Webhooks (H1)**
- Every delivery resolves the destination inside the socket's own DNS lookup
  and refuses non-public addresses: private, loopback, link-local, CGNAT,
  metadata, ULA, multicast, reserved and IPv4-mapped/NAT64 forms. The
  connection uses exactly the vetted address, so rebinding can't reach an
  internal host.
- At creation, IP literals in those ranges, single-label names, local suffixes
  and URLs with credentials are refused; production requires https.
- Redirects are never followed. Stored errors are coarse categories
  ("connection failed", "timeout", "HTTP 5xx"), never raw error text.
- `WEBHOOK_ALLOW_PRIVATE=1` (all) or `WEBHOOK_ALLOWED_HOSTS` (named hosts) for
  self-hosters whose receivers live on the same network. The rules apply in
  every mode unless one of these is set.

**Compose defaults (H2)**
- Infrastructure ports bind to `127.0.0.1` (`SP_INFRA_BIND` to change).
- NATS requires a user per service (`api`, `media`, `brain`); services pass
  `NATS_USER`/`NATS_PASSWORD`.
- `deploy/compose/init-secrets.sh` writes `deploy/compose/.env` with random
  credentials for Postgres, the app role, NATS users, object storage and the
  service secrets. Without it, development defaults are used.
- In production mode the API and media refuse to start with any development
  credential, unauthenticated NATS, `MEDIA_DEV_REPLAY`, or (API) without
  `API_PUBLIC_URL`; MCP refuses without `MCP_PUBLIC_URL`.

## Consequences
- Existing compose volumes keep their old Postgres role passwords (the init
  script runs only on an empty volume); rotate them by hand or recreate.
- NATS users all share one account today; per-service subject permissions are
  a follow-up.
