# 48. Connecting MCP clients with a console sign-in

Date: 2026-10-17 · Status: accepted; amends ADR 0023, 0031, 0039, 0047

## Context
Connecting Claude Code or Cursor should feel like connecting Notion or GitHub:
press Connect, sign in, choose what the app may use, Allow. Until now the MCP
consent page (on the MCP origin) asked people to paste an agent key they had
first created in the console, and the console itself offered "sign in with an
API key". Both are out of place for people; keys are for code.

## Decision
- **The consent page lives in the console** (`/connect`), next to sign-in, so
  it reuses the console's sign-in (password, Google, GitHub), design and
  session. The MCP service keeps the OAuth endpoints:
  1. `GET /oauth/authorize` (MCP) checks the client, redirect URI and PKCE,
     seals the request with a random nonce (`MCP_TOKEN_SECRET`, 15 minutes)
     and redirects to `<MCP_CONSOLE_URL>/connect#request=<sealed>` (a fragment,
     so it stays out of server logs).
  2. The console reads `GET /oauth/request` (MCP, any origin): client name,
     redirect host, verified or not, and `binding` = SHA-256 of the nonce. The
     console talks only to its configured MCP address (`VITE_MCP_URL`, else
     `mcp_url` from `/auth/providers`, from `MCP_PUBLIC_URL` on the API), never
     one named in a link.
  3. The person signs in if needed. A tab without a session first asks this
     browser's other console tabs for theirs (`BroadcastChannel`, same origin
     only), so an open console means no second sign-in.
  4. They pick cameras and sensors and permissions, then Allow:
     `POST /v1/agents/connect` (API, console session) creates or reuses the
     app's agent, replaces its grants and returns a single-use **connect code**
     (2 minutes, stored hashed, bound to `binding`, client name and host). No
     key is returned.
  5. The console form-posts `{request, code}` to `POST /oauth/approve` (MCP).
     The MCP service redeems the code server to server at
     `POST /auth/connect/redeem` with the nonce only it can read; the API
     checks hash, name and host, spends the code (even on mismatch) and issues
     a new agent key, which the MCP service seals into the OAuth code as before.
     The client then exchanges it with PKCE. Cancel posts to `POST /oauth/deny`,
     which redirects with `error=access_denied`.
- **Identity never crosses origins.** The console session stays in the
  console's tab storage and is used only against the API, as on every console
  page. The MCP service gets a code that is useless without its own sealed
  nonce, and the client gets an OAuth code that is useless without its PKCE
  verifier. No cookies are shared.
- **Security properties kept:** redirect URI rules (https, loopback http,
  reverse-DNS app schemes, at most 10, no fragments), PKCE S256 only,
  single-use OAuth codes (ADR 0026), the unverified-host warning
  (`MCP_TRUSTED_REDIRECT_HOSTS`), per-IP OAuth limits (ADR 0040) on all
  `/oauth/*` routes including the new ones, `frame-ancestors 'none'` on MCP
  pages. Redeem is limited to 120 a minute per IP (every redeem comes from the
  MCP service).
- **An app is an agent** (`agents.kind = 'app'`, `client_name`, `client_host`,
  `connected_at`), named after the client ("Claude Code"). Tokens carry its
  key, so editing its grants applies on the next request and disconnecting
  (`DELETE /v1/agents/{id}`) revokes its keys: tool calls fail at once and
  refreshes fail.
- **Reconnect rule:** the same client name and redirect host (port ignored,
  every loopback name as `localhost`) in the same workspace reuses the live app:
  its grants are replaced by the new choice and the consent page pre-fills the
  current access. Each connection gets its own key so two machines can stay
  connected; an app keeps its five newest keys. A different host is a
  different app, even with the same name, so a look-alike client can't take
  over an existing app's access.
- **Role rule:** admins and owners approve (the route falls under ADR 0044's
  default admin rule, like creating agents). Members and viewers see who to ask
  and can only Cancel. Account API keys may call `/v1/agents/connect` (they act
  as an owner); agent keys can't.
- **Permissions → grants:** Look = `video`, Listen = `audio`, Read environment
  = `temperature` + `humidity`; Set watches and See history and replay are a
  new grant field, `abilities` (`watch`, `history`; default both, so existing
  grants keep their behaviour). Without `watch`, watch writes are `403
  forbidden`. Without `history`, recorded-data routes only reach the last two
  hours (enough for `listen` and the `read_environment` trend). New apps get
  everything except Listen (audio is opt-in).
- **No API-key sign-in anywhere.** The console sign-in page and the consent
  page no longer take keys. API keys stay for code: the REST API, the SDK, the
  stdio MCP server (`SENSEPLANE_API_KEY`), webhooks tooling, the CLI. The
  console's Agents page leads with connected apps (connected, last active,
  access edited in place with the consent picker, Disconnect) and keeps API
  keys in a "For developers" section; a key is shown once.
- **`MCP_ALLOW_OWNER_KEYS` is removed** (consent no longer takes keys, so
  nothing to relax). `Authorization: Bearer sk_…` on `/mcp` still works for
  clients and scripts that send headers.
- **Self-host first run:** open sign-up (the development default) → Create an
  account; closed sign-up → `create-account` then `create-user` with
  `SENSEPLANE_PASSWORD`, then sign in. `MCP_CONSOLE_URL` (default
  `CONSOLE_URL`) is required on the MCP service in production.
- **Last active** comes from the newest audit entry for `agent:<id>` (new index
  on `audit_log(account_id, actor, occurred_at)`).

## Consequences
- The MCP service now calls the API's `/auth/connect/redeem` and needs to know
  the console's URL; the console needs the MCP address (build-time or from the
  API).
- A sealed request can be shown more than once within its 15 minutes, but it
  only becomes a code through an admin's approval in the console.
- Tokens still carry the app's key sealed with `MCP_TOKEN_SECRET` (ADR 0039's
  deferred token store remains deferred); consent can only mint agent keys.
- Old remote MCP connections made with pasted agent keys keep working until
  those keys are revoked; they show under "For developers".

## Other choices
- Consent on the console origin rather than the MCP origin.
- Reuse by (client name, redirect host), keys capped at five per app.
- Admins and owners approve; members can't connect apps.
- "See history" means older than two hours; Listen is off by default.
- Session borrowing between console tabs through `BroadcastChannel`.
- "Use another account" on the consent page forgets the session in that tab
  without ending it (it may be another tab's).
