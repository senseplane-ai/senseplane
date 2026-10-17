# @senseplane/api

Public REST API (`/v1`), the only service that connects to Postgres.

```ts
import { createApi } from "@senseplane/api";
const api = await createApi({ database: process.env.DATABASE_URL!, modules: [], internalPort: 9090 });
await api.listen({ port: 8080 });
```

`createApi`, `ApiModule`, `ModuleContext` and `DataAccess` are the stable
extension interface (ADR 0007). Tenancy is enforced by row-level security
(ADR 0006): every request runs in `data.withAccount(accountId, fn)`.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Runtime connection as `senseplane_app` (non-superuser) |
| `MIGRATION_DATABASE_URL` | no | Owner connection; when set, migrations run on start |
| `MEDIA_CONTROL_URL` | yes | The media plane's control API (`spec/media`), e.g. `http://media:8090`; `https://` for a remote one |
| `MEDIA_SIGNING_KEY` | production | `kid:base64pem` (base64 of an Ed25519 PKCS8 PEM): signs join, control and WHIP tokens; its public half goes in the media plane's `MEDIA_TOKEN_PUBLIC_KEYS`. Generated and stored in the database outside production |
| `MEDIA_ISSUER` | no | The media plane's instance id, put in `iss` (default `senseplane`) |
| `MEDIA_PUBLIC_URL` | for WHIP | The media plane's public base; enables WHIP and is the base of the WHIP URL given to bridges and encoders |
| `API_CALLBACK_URL` | no | The base the media plane calls back (room events, feed uploads and frames, WHIP authorize). Default `API_PUBLIC_URL` |
| `CAPTURE_URL` | yes | Capture page URL put in `capture_url` |
| `VALKEY_URL` | no | Valkey (`redis://[:password@]host:port`): the brain bus, live state, the balancer. Without it frames reach no brain |
| `FEED_IDLE_STOP_SECONDS` | no | A camera's feed egress is stopped after it has been offline this long (default 600) |
| `MEDIA_MAX_VIEWERS_PER_SOURCE` | no | Live viewers per camera (default 50) |
| `LIVE_IDLE_TIMEOUT_SECONDS` | no | Live viewers without a keepalive are closed after this long (default 600) |
| `LIVE_SWEEP_SECONDS` | no | How often idle live viewers are swept (default 10) |
| `CORS_ORIGINS` | no | Comma-separated console origins |
| `INGEST_SIGNING_KEY` | no | Older name for `MEDIA_SIGNING_KEY`, read when that is unset |
| `RAW_RETENTION_DAYS` | no | Default raw retention for new accounts (CLI), default 7 |
| `RAW_RETENTION_MAX_DAYS` | no | Instance maximum (unset = no limit) |
| `QUOTA_MAX_SOURCES`, `QUOTA_MAX_ACTIVE_SOURCES`, `QUOTA_MAX_RESOLUTION`, `QUOTA_LIVE_VIEW`, `QUOTA_MAX_LIVE_VIEWERS` | no | The default quota when no quota provider is plugged in ([self-hosting](../docs/self-host.md#api-api)) |
| `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_EXPENSIVE_PER_MINUTE`, `RATE_LIMIT_ANONYMOUS_PER_MINUTE` | no | Request limits (default 600, 30, 600; ADR 0040) |
| `TRUSTED_PROXIES`, `TRUST_PROXY` | no | Proxy CIDRs or a hop count, so client IPs come from `X-Forwarded-For` |
| `WEBHOOK_ALLOW_PRIVATE`, `WEBHOOK_ALLOWED_HOSTS` | no | Allow webhooks to private or listed internal hosts (refused by default, ADR 0035) |
| `METRICS_TOKEN` | no | Bearer token for `/metrics`; in production `/metrics` isn't served without it |
| `API_PUBLIC_URL` | no | Base URL put in capture and playback links (default: request origin) |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | for playback | Object storage (enables playback, clips, sweeper) |
| `S3_UPLOAD_ENDPOINT` | no | The bucket URL put in presigned upload URLs the media plane PUTs segments to (default `S3_ENDPOINT`); internet-reachable for a remote media plane |
| `S3_PUBLIC_ENDPOINT` | no | Browser-reachable S3 URL: segments redirect to presigned URLs instead of streaming through the API |
| `PLAYBACK_SIGNING_SECRET` | production | HMAC secret for playback URLs (generated outside production) |
| `SECRETS_ENCRYPTION_KEY` | production | At least 32 characters; encrypts webhook signing secrets at rest (generated and stored outside production; ADR 0027). Keep it stable: losing it means re-creating webhooks |
| `DEMO_ORIGINS` | no | Comma-separated browser origins allowed to call the live demo API (`/v1/demo/*`, `/v1/capture/join`). Default: the local dev site only; set your website's origin to enable the demo |
| `CONSOLE_URL` | no | Console origin(s) sign-in may return to, comma-separated (default http://localhost:5173); invite links use the first |
| `MCP_PUBLIC_URL` | no | The MCP server's public base URL, given to the console in `/auth/providers` (`mcp_url`) for connecting apps |
| `AUTH_SIGNUP` | no | `open` lets anyone create an account at `/auth/signup` or through Google/GitHub; `closed` refuses it (accounts come from the CLI, `senseplane-admin`); `first` lets only the first person sign up (they own the workspace), then closes (the self-host compose file's setting). Unset: open outside production mode, closed in production. Invited people can always sign up (ADR 0044) |
| `AUTH_INVITE_DAYS` | no | How long invite links stay valid (default 7) |
| `AUTH_PASSWORD` | no | `off` disables email and password sign-in (default on) |
| `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET` | no | Enables "Continue with Google" (callback: `<api>/auth/oauth/google/callback`) |
| `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET` | no | Enables "Continue with GitHub" (callback: `<api>/auth/oauth/github/callback`) |
| `AUTH_SESSION_DAYS` | no | Console session lifetime (default 30) |
| `AUTH_CHALLENGE_SITE_KEY`, `AUTH_CHALLENGE_PROVIDER` | no | Shows a sign-up challenge widget (provider `turnstile`); a module verifies the token in `onSignup` |
| `RETENTION_SWEEP_SECONDS` | no | Sweeper interval, default 600; 0 disables (ADR 0016) |
| `PORT` | no | Public port (default 8080) |
| `INTERNAL_HOST` | no | Bind address for the internal listener (default 127.0.0.1) |
| `LOG_LEVEL` | no | pino level (default info) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_*` | no | OpenTelemetry tracing, off unless the endpoint is set ([docs/observability.md](../docs/observability.md)) |

## Endpoints

`/healthz`, `/metrics`, `/.well-known/senseplane-ingest-jwks.json`,
`POST /v1/capture/join` (capture ticket), `POST /internal/media/callbacks`
(the media plane's callbacks, each with the bearer the API gave it), signed
`/playback/{token}/…` (HLS), `/auth/*` (console sign-in), and the public `/v1`
API in `spec/openapi.yaml` ([API guide](../docs/api/README.md)). Unknown `/v1/*`
routes return `501 not_implemented`.

Create an account and key: `node dist/cli.js create-account "Name"`; add a
console sign-in to it with `SENSEPLANE_PASSWORD=… node dist/cli.js create-user <account_id> <email>`.

## Tests

Need the compose Postgres (`docker compose -f deploy/compose/docker-compose.yml up -d`)
and a Valkey for the bus and balancer tests. Override with `TEST_ADMIN_DATABASE_URL`
and `TEST_VALKEY_URL`.
