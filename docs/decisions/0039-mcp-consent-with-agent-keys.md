# 39. MCP consent with agent keys only

Date: 2026-10-17 · Status: accepted · The key-pasting consent page is superseded by ADR 0048

## Context
Dynamic client registration accepts any client name, so a phishing client can
call itself "Claude". The consent page asked people to paste an API key, and
an owner key gives the client full access to the account.

## Decision
- The consent page names the host the authorization code is sent to, and marks
  it "not verified" unless it is in `MCP_TRUSTED_REDIRECT_HOSTS`.
- It asks for an **agent key** and refuses owner keys (the MCP service checks
  whether the key can read the account). `MCP_ALLOW_OWNER_KEYS=1` lifts this for
  self-hosters.
- Redirect URIs must be https, loopback http, or a reverse-DNS private-use
  scheme (`com.example.app:/cb`); at most 10 per client, no fragments.
- Registration and the other OAuth endpoints are rate limited per IP (ADR 0040).

## Deferred
Tokens still carry the (agent) API key sealed with `MCP_TOKEN_SECRET`. Storing
tokens server-side, so a leaked secret reveals no keys and tokens can be
revoked one by one, needs a token store in the MCP service; tracked as a
follow-up. Limiting consent to agent keys bounds the impact meanwhile.

## Addendum (2026-10-17): consent without keys (ADR 0048)

- The consent page no longer takes a key of any kind. It moved to the
  console (`/connect`), where people sign in as themselves and pick cameras,
  sensors and permissions; the API creates an agent for the app and the MCP
  service receives its key through a single-use connect code it redeems
  server to server. Only agent keys can come out of consent, so the
  owner-key check and `MCP_ALLOW_OWNER_KEYS` are gone.
- Kept: the redirect host shown on the consent page and the "not verified"
  warning for hosts outside `MCP_TRUSTED_REDIRECT_HOSTS` (now returned by
  `GET /oauth/request` and rendered by the console), the redirect URI rules,
  and the per-IP limits, which also cover `/oauth/request`, `/oauth/approve`
  and `/oauth/deny`.
- Still deferred: a server-side token store (tokens carry the app's key sealed
  with `MCP_TOKEN_SECRET`). Disconnecting an app revokes its keys, which ends
  its tokens on their next use.
