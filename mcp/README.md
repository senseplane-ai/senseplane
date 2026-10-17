# @senseplane/mcp

MCP server with the 8 Senseplane tools (`list_senses`, `look`, `listen`,
`read_environment`, `watch_for`, `what_happened`, `replay`, `stop_watching`).
Tool definitions come from `spec/mcp/tools.json` (`pnpm codegen`); each tool is
a call into the public API through the TypeScript SDK (`src/handlers.ts`).

- **stdio:** `SENSEPLANE_API_KEY=sk_… SENSEPLANE_API_URL=http://localhost:58080/v1 node dist/stdio.js` (bin `senseplane-mcp`).
- **Remote:** `node dist/server.js` serves Streamable HTTP at `/mcp` (stateless),
  with OAuth 2.1 (dynamic client registration, authorization code + PKCE S256,
  refresh tokens) or an API key sent as `Authorization: Bearer sk_…`. Consent
  happens on the console's `/connect` page, where a person signs in and picks
  access; this service redeems the resulting connect code at the API for the
  app's agent key (ADR 0023, 0048).

Environment: `PORT` (8060), `SENSEPLANE_API_URL`, `MCP_PUBLIC_URL` (issuer and
resource URL), `MCP_CONSOLE_URL` (the console, for consent; default
`CONSOLE_URL`, required in production), `MCP_TRUSTED_REDIRECT_HOSTS` (redirect
hosts shown as verified), `MCP_TOKEN_SECRET` (required in production; seals OAuth
clients, codes and tokens), `VALKEY_URL` (required in production: records redeemed
OAuth codes so each is single-use across instances, ADR 0026, 0051), `SENSEPLANE_PUBLIC_API_URL` (map media URLs back
to `SENSEPLANE_API_URL` inside a container network), `LOG_LEVEL`, `TRUSTED_PROXIES` / `TRUST_PROXY`, and the standard `OTEL_*` variables for tracing (off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; [docs/observability.md](../docs/observability.md)).

See [docs/quickstart.md](../docs/quickstart.md) for client configuration.
