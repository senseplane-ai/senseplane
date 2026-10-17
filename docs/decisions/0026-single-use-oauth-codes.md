# 26. Single-use OAuth authorization codes

Date: 2026-10-17 · Status: accepted · The JetStream store is superseded by Valkey (ADR 0051)

## Context
The MCP OAuth server (ADR 0023) seals codes and tokens so it needs no database.
A sealed code was valid until it expired (2 minutes) and could be exchanged
more than once. OAuth 2.1 (§4.1.3) requires codes to be single-use, and a
reused code should revoke the tokens already issued from it.

## Decision
- Every code carries a random id (`jti`). Tokens issued from it carry the same
  id (`gj`).
- The token endpoint records the id in an `OAuthGrantStore` when a code is
  redeemed. A second redemption fails with `invalid_grant` and revokes the id;
  access and refresh tokens carrying a revoked id are refused.
- Stores: in-memory (one instance, dev) and a JetStream KV bucket
  (`mcp_oauth_grants`, used when `NATS_URL` is set; `create` is atomic, so only
  one instance wins). Entries expire with the refresh-token lifetime.
- In production the MCP service refuses to start without a shared store.

## Consequences
Tokens minted before this change carry no `gj` and are refused; clients sign
in again once. MCP instances need NATS in production, which the compose bundle
already runs.
