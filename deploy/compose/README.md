# Local development compose

For contributors. To run Senseplane on a server, use the one-file setup at
the repository root instead: [docs/self-host-vm.md](../../docs/self-host-vm.md).

```sh
docker compose up -d            # infrastructure only
docker compose --profile app up -d --build   # plus the Senseplane services
```

| Service | Image | Host port |
|---|---|---|
| Postgres 17 + pgvector | `pgvector/pgvector:pg17` | 55432 |
| Valkey (AOF on, password) | `valkey/valkey:8.1.4-alpine` | 56379 |
| S3-compatible storage | RustFS `rustfs/rustfs:1.0.0` (ADR 0013) | 59000 (console 59001) |
| API (`--profile app`) | built from `api/` | 58080 |
| Media (`--profile app`) | built from `media/` (LGPL FFmpeg inside): signalling, `/control/*`, WHIP, feed egress | 58090, WebRTC 40000 udp/tcp |
| MCP (`--profile app`) | built from `mcp/` | 58060 |
| Brain (`--profile app`) | built from `brain/` | internal |

Host ports are offset so they don't clash with other local stacks; override
with `SP_PG_PORT`, `SP_VALKEY_PORT`, `SP_S3_PORT`, `SP_API_PORT`, … .
`postgres/init.sh` creates the `vector` extension and the non-superuser
`senseplane_app` role the API connects as (row-level security, ADR 0006).
The `s3-setup` job creates the `senseplane` bucket. Set `RAW_RETENTION_MAX_DAYS`
to also add a lifecycle backstop on `raw/` (the API sweeper is the real deleter, ADR 0016).

Sign up in the console (open by default on this development stack), or, with sign-up closed, create an account (and an API key for code) with `docker compose exec api node dist/cli.js create-account "Name"` and its first sign-in with `docker compose exec -e SENSEPLANE_PASSWORD=… api node dist/cli.js create-user <account_id> <email>`.
For a real phone on your network see [docs/dev/phone-testing.md](../../docs/dev/phone-testing.md).

Default credentials, the `dev-1` media key pair and the `dev-valkey`
password are for local use only. `./init-secrets.sh` writes real ones to
`deploy/compose/.env` (read automatically): database and storage passwords,
`VALKEY_PASSWORD`, `MCP_TOKEN_SECRET`, `PLAYBACK_SIGNING_SECRET` and an Ed25519
`MEDIA_SIGNING_KEY` with its public half `MEDIA_TOKEN_PUBLIC_KEYS`. Production
mode refuses the development values.

Run the API against a media plane elsewhere: [docs/external-media-plane.md](../../docs/external-media-plane.md)
(`--scale media=0`).
