# 23. MCP: stdio and stateless remote HTTP with sealed OAuth tokens

Date: 2026-10-16 · Status: accepted · Amended by ADR 0026 (single-use codes), 0039 and 0048 (consent)

## Context
Agents reach Senseplane through MCP: locally (Claude Desktop, Claude Code,
Cursor run a command) and remotely (clients that connect to a URL and expect
the MCP authorization spec: OAuth 2.1, PKCE, dynamic client registration).
Senseplane has API keys but no user logins.

## Decision
- **One implementation, two transports.** `mcp/src/handlers.ts` maps the 8
  tools in `spec/mcp/tools.json` onto the public API through the TypeScript
  SDK; the MCP server holds no data and no database connection. stdio takes
  `SENSEPLANE_API_KEY`; remote serves Streamable HTTP at `/mcp`, stateless
  (a server per request, JSON responses, no sessions), so it scales out
  behind any load balancer.
- **OAuth 2.1 in the MCP service.** Protected-resource and authorization-
  server metadata, `/oauth/register` (dynamic registration, public clients,
  https/loopback/app-scheme redirect URIs), `/oauth/authorize` (a consent page
  where the person pastes an API key), `/oauth/token` (authorization code with
  PKCE S256 only; refresh tokens). Access tokens live 1 h, refresh tokens 30
  days, codes 2 min.
- **Stateless and sealed.** Client ids, codes and tokens are AES-256-GCM
  blobs sealed with `MCP_TOKEN_SECRET` (required in production); the API key
  inside is never visible to the client. Nothing is stored, so restarts and
  more instances need no shared state.
- **Revocation follows the key.** Every tool call goes to the API with the
  sealed key, and a refresh re-checks it, so revoking the API key (M6) cuts
  off its tokens on the next call.
- A raw API key in `Authorization: Bearer sk_…` is accepted too, for clients
  that take headers.
- Tool behaviour: sources can be named by id or name; `look` returns the
  image as an MCP image block (and the signed URL); `listen` waits the given
  seconds and returns sound episodes that started or are still going on
  (never speech); `read_environment` adds a last-hour trend; `watch_for` takes
  `duration_minutes` (new `WatchCreate.duration_minutes`, watch status
  `expired`).

## Consequences
- A code can be replayed within its 2-minute life (no server-side "used"
  list). PKCE and the client/redirect binding limit that to the party holding
  the verifier.
- Changing `MCP_TOKEN_SECRET` signs everyone out of remote MCP.
- When M6 adds per-agent grants, the consent page can issue tokens for an
  agent grant instead of a full-account key.

## Addendum (2026-10-17)

The consent page described above (paste an API key) is replaced by the
console's `/connect` page and connect codes (ADR 0048). `/oauth/authorize` now
redirects to the console; `/oauth/request`, `/oauth/approve` and `/oauth/deny`
are new. Tokens are tied to the connected app's agent key.
