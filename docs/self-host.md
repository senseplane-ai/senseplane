# Self-hosting Senseplane

Senseplane runs on one Linux machine with Docker Compose: the API, the media
plane, the brain (perception and watches), the MCP server, Postgres with
pgvector, Valkey and S3-compatible object storage.

**The quickest way** is the one-file setup in [Run Senseplane on a
VM](self-host-vm.md): `docker-compose.yml` at the repository root, with Caddy
in front for HTTPS on your domain, passwords in the file, signing keys generated on first start and every
public URL derived from the domain. This page is the reference behind it:
requirements, every variable, and running the services your own way.

Before you point cameras at people, read [Lawful camera use](lawful-use.md).

## Requirements

- **Linux with Docker Engine and the Compose plugin** (macOS and Windows work
  for development).
- **x86-64 or ARM64.**
- **An OpenAI-compatible model endpoint** for watches, `look`, `ask` and event
  summaries: a model provider's API (for example OpenRouter) or a local server
  (Ollama, vLLM, LM Studio). Without one, detection, recording and watches
  still work, but `look` and `ask` don't, and watches fire without a model
  check.
- **Network:** clients must reach the media plane's WebRTC port (40000
  TCP/UDP by default) directly, not only through a web proxy.

### Sizing

Detection runs on the CPU (ONNX Runtime). Recording copies the stream without
re-encoding, so it's cheap; decoding for analysis and object detection are
the main CPU cost, and they only run hard while something is moving.

| Setup | CPU | RAM | Disk |
|---|---|---|---|
| Up to 4 cameras | 4 cores | 8 GB | ~80 GB per camera for 7 days at 720p |
| Up to 20 cameras | 8+ cores | 16–32 GB | as above, per camera |

A 720p camera at about 1 Mbps records roughly 10.8 GB a day. Disk use is
`cameras × days × ~10.8 GB` plus clips and snapshots. One media node recorded
50 simultaneous 1080p streams using about a third of one CPU core and 1.7 GB
of RAM (`docs/milestones/m2.md`); memory (~30 MB per recording stream) is the
media plane's limit, not CPU.

**What a camera costs the brain:** an int8 build of the detector looks at every
frame, and the full model confirms anything new before an event (ADR 0055).
A quiet camera costs a few hundredths of a core, a busy one about a core while
the activity lasts ([numbers](milestones/brain-tuning.md)). On a very small
machine, `DETECTOR_MODEL=yolox_tiny DETECTOR_CONFIRM_MODEL=none` is cheaper
still, and less accurate on small or distant objects.

**More brains:** start more `brain` containers (`--scale brain=3`). The API
assigns each camera to one live brain by load and moves it within about ten
seconds if that brain stops (ADR 0052).

**GPU:** not used yet. Detection and embeddings run on the CPU.

## Install

The [one-file setup](self-host-vm.md) does all of this for you. By hand, from
the development compose file:

```sh
git clone https://github.com/senseplane-ai/senseplane && cd senseplane
cp .env.example .env          # set AI_BASE_URL, AI_API_KEY and model choices
docker compose -f deploy/compose/docker-compose.yml --profile app up -d --build
```

Then make your first sign-in, and open the console:

- **Sign-up open** (the development default, or `AUTH_SIGNUP=open`): open the
  console and choose **Create an account**. You own the new workspace.
- **Sign-up closed** (production mode's default): create the workspace and its
  owner with the CLI, then sign in with that email and password:

  ```sh
  docker compose -f deploy/compose/docker-compose.yml exec api node dist/cli.js create-account "My home"
  # {"account_id":"…","api_key":"sk_…"}   the key is for code (REST, SDK); keep it secret
  docker compose -f deploy/compose/docker-compose.yml exec -e SENSEPLANE_PASSWORD='a long password' \
    api node dist/cli.js create-user <account_id> you@example.com
  ```

The console has no API-key sign-in: people sign in as themselves (password,
or Google/GitHub when configured), and API keys are only for code.

The API runs database migrations on start. The `s3-setup` job creates the
bucket and exits.

## Configuration

Set variables in your environment or a Compose override file
(`docker-compose.override.yml`). The defaults in
`deploy/compose/docker-compose.yml` are for development.

### Production mode and required secrets

Set `SENSEPLANE_MODE=production` (or `NODE_ENV=production`) on every service.
In production mode, services **refuse to start** without real secrets:

| Variable | Service | What it is |
|---|---|---|
| `MEDIA_SIGNING_KEY` | api | `kid:base64pem`: the Ed25519 key that signs capture links and media tokens. Its public half, `MEDIA_TOKEN_PUBLIC_KEYS`, goes on `media`. Must not be the compose `dev-1` key. |
| `MEDIA_TOKEN_PUBLIC_KEYS` | media | The public half of `MEDIA_SIGNING_KEY` (`kid:base64pem`, comma-separated during a key rotation). |
| `VALKEY_PASSWORD` | valkey, api, brain, mcp | Valkey's password (in `VALKEY_URL` for the services). Must not be the compose default. |
| `PLAYBACK_SIGNING_SECRET` | api | Secret for signed playback, snapshot and clip URLs. |
| `MCP_TOKEN_SECRET` | mcp | Secret for the MCP server's OAuth tokens. Must not be `dev-only-change-me`. |

`deploy/compose/init-secrets.sh` writes all of them (and the database and
storage passwords) to `deploy/compose/.env`, which Compose reads; it keeps
existing values, so it is safe to run again. By hand:

```sh
openssl genpkey -algorithm ed25519 -out media.pem
echo "MEDIA_SIGNING_KEY=sp-1:$(base64 < media.pem | tr -d '\n')"
echo "MEDIA_TOKEN_PUBLIC_KEYS=sp-1:$(openssl pkey -in media.pem -pubout | base64 | tr -d '\n')"
openssl rand -base64 48                            # each of the other secrets
```

`INGEST_SIGNING_KEY` is still read as an older name for `MEDIA_SIGNING_KEY`.
Capture links signed with the key the API generated before you set one keep
working (verify only). Changing `MEDIA_SIGNING_KEY` ends WHIP tokens issued
with the old key: issue new ones (`POST /v1/sources/{id}/ingest-token`).

Production mode also requires webhook URLs to be public `https` addresses.

Change the database and object-storage passwords from the compose defaults
too (`senseplane`/`senseplane_app`, and `senseplane`/`senseplane-secret`).

### API (`api`)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | compose value | Postgres URL for the app role (row-level security applies) |
| `MIGRATION_DATABASE_URL` | compose value | Postgres URL for the owner role; runs migrations at start |
| `VALKEY_URL` | compose value | Valkey: the brain bus, the balancer, live state |
| `PORT` | `8080` | HTTP port |
| `API_PUBLIC_URL` | `http://localhost:58080` | How browsers (the capture page) reach the API |
| `CAPTURE_URL` | `http://localhost:5173/capture.html` | Capture page address put in capture links and QR codes |
| `CORS_ORIGINS` | console origin | Comma-separated browser origins allowed to call the API |
| `MEDIA_CONTROL_URL` | `http://media:8090` | The media plane's control API (`/control/*`, token-authenticated) |
| `MEDIA_ISSUER` | `senseplane` | The media plane's instance id (`MEDIA_INSTANCE_ID` on `media`) |
| `API_CALLBACK_URL` | `API_PUBLIC_URL` (compose: `http://api:8080`) | Where the media plane calls back: room and feed events, upload URLs, frames, WHIP authorize |
| `FEED_IDLE_STOP_SECONDS` | `600` | A camera's feed is stopped after it has been offline this long |
| `MEDIA_MAX_VIEWERS_PER_SOURCE` | `50` | Live viewers per camera |
| `S3_UPLOAD_ENDPOINT` | `S3_ENDPOINT` | The bucket URL in the presigned upload URLs the media plane PUTs segments to |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_FORCE_PATH_STYLE` | compose values, `us-east-1`, `true` | Object storage |
| `S3_PUBLIC_ENDPOINT` | empty | Browser-reachable S3 URL. When set, playback redirects to presigned object URLs instead of streaming segments through the API. |
| `RAW_RETENTION_DAYS` | `7` | Default raw footage retention for new accounts |
| `RAW_RETENTION_MAX_DAYS` | empty | Optional upper limit for `retention_days`; also adds a storage lifecycle backstop |
| `RETENTION_SWEEP_SECONDS` | `600` | How often expired footage is deleted |
| `QUOTA_MAX_SOURCES` | unlimited | Registered sources per account |
| `QUOTA_MAX_ACTIVE_SOURCES` | unlimited | Sources streaming at once per account |
| `QUOTA_MAX_RESOLUTION` | `720p` | Largest recording resolution (`720p` or `1080p`) |
| `QUOTA_MAX_AI_CHECKS_PER_DAY` | unset (no cap) | AI checks (model calls) per account per UTC day. Over it, `ask`, chat and new watches answer 429 `allowance_exhausted` and watches pause until the next day |
| `QUOTA_LIVE_VIEW` | `1` | `0` turns live view off for every account (ADR 0042) |
| `QUOTA_MAX_LIVE_VIEWERS` | unlimited | People watching live at once per account |
| `LIVE_IDLE_TIMEOUT_SECONDS` | `600` | Live viewers with no activity for this long are closed |
| `LIVE_SWEEP_SECONDS` | `10` | How often idle live viewers are swept |
| `DEMO_ORIGINS`, `DEMO_CAPTURE_URL`, `DEMO_SESSIONS_PER_IP_DAY` | see compose, `5` | The optional no-signup demo API |
| `TRUST_PROXY`, `TRUSTED_PROXIES` | off | Behind a reverse proxy: the number of proxy hops (`1`), or the proxies' CIDRs, so client IPs are read from `X-Forwarded-For` |
| `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_EXPENSIVE_PER_MINUTE`, `RATE_LIMIT_ANONYMOUS_PER_MINUTE` | `600`, `30`, `600` | Requests per minute per key (or per IP without one), for model and search calls, and per IP for unauthenticated routes; `0` turns a limit off (ADR 0040) |
| `LOG_LEVEL` | `info` | Log level (JSON logs) |
| `MEDIA_PUBLIC_URL` | `http://localhost:58090` | The media plane's public URL; WHIP sources and bridges push to `<this>/whip/<source>` |
| `BRIDGE_IMAGE` | `ghcr.io/senseplane-ai/bridge:0.1` | Image name in the `docker run` command shown for IP cameras |
| `SECRETS_ENCRYPTION_KEY` | generated outside production | Encrypts webhook secrets and camera RTSP URLs at rest (keep it with your backups) |

### Media plane (`media`)

The open-source media plane implements the media contract (`spec/media`,
ADR 0049) and nothing Senseplane-specific: it has no database, no bus and no
bucket credentials. Recording and analysis frames are a feed egress per
camera that the API starts; segments go to storage through presigned URLs the
API hands out (ADR 0050). Full list: `media/README.md`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8090` | The one listener: signalling (WebSocket), `/control/*`, `/whip` |
| `MEDIA_ROLES` | `ingress,egress` | Which roles this process runs; split them across hosts with `MEDIA_EGRESS_URL` and `MEDIA_EGRESS_SECRET` |
| `MEDIA_TOKEN_PUBLIC_KEYS` | compose `dev-1` key | The keys it trusts (the public half of the API's `MEDIA_SIGNING_KEY`) |
| `MEDIA_INSTANCE_ID` | `MEDIA_ISSUER` | The issuer tokens must carry |
| `MEDIA_URL` | `ws://localhost:58090/` | Signalling URL sent to browsers (`wss://…` behind TLS) |
| `MEDIA_ANNOUNCED_ADDRESS` | `127.0.0.1` | The IP address browsers use for WebRTC: your server's public or LAN IP |
| `MEDIA_RTC_PORT` | `40000` | Fixed WebRTC port (TCP and UDP); open it in your firewall |
| `MEDIA_INTERNAL_ADDRESS` | unset (`auto` in compose) | A second address offered for WebRTC, for publishers on the media plane's own network (a bridge container next to it); `auto` uses the machine's first non-loopback IPv4 |
| `MEDIA_RTC_INTERNAL_PORT` | RTC port + 100 | The port for that address (internal only; don't publish it) |
| `MEDIA_WORKERS` | min(cores, 4) | mediasoup workers |
| `WHIP_CORS_ORIGINS` | any | Browser origins allowed to publish over WHIP (comma-separated) |

Keep `MEDIA_RTC_PORT` fixed. A per-connection port range didn't connect
reliably in testing.

### Brain (`brain`)

| Variable | Default | Purpose |
|---|---|---|
| `AI_BASE_URL`, `AI_API_KEY` | from `.env` | OpenAI-compatible model endpoint |
| `AI_MODEL_VISION` | compose value | Model for `look`, `ask`, watch checks and summaries (must accept images) |
| `AI_MODEL_TEXT` | compose value | Model that compiles watches |
| `AI_MODEL_COMPILE`, `AI_MODEL_SUMMARY`, `AI_MODEL_CHAT` | unset | Optional per-task overrides (`AI_MODEL_CHAT` answers conversations and must support tool calls; ADR 0041) |
| `DETECTOR_MODEL` | `yolox_s_int8` | The detector that looks at every frame: `yolox_s_int8`, `yolox_s` or `yolox_tiny` |
| `DETECTOR_CONFIRM_MODEL` | `yolox_s` | Confirms what the detector sees new before an event; `none` turns the cascade off |
| `DETECTOR_THREADS` | `2` (dev compose: `4`; one-file setup: the CPU count, up to 4) | CPU threads for detection |
| `SENSEPLANE_MODELS_DIR` | in the container | Where downloaded model files are cached |

The brain doesn't test the model at start. Without `AI_BASE_URL` and
`AI_MODEL_VISION`, `look` and `ask` are off and watches are compiled by rules
and fire unverified; a wrong key or a model
that doesn't accept images shows up as model errors in the brain's log when
the first watch is checked or question asked.

### MCP server (`mcp`)

| Variable | Default | Purpose |
|---|---|---|
| `SENSEPLANE_API_URL` | `http://api:8080/v1` | API URL from inside the network |
| `SENSEPLANE_PUBLIC_API_URL` | `http://localhost:58080` | Public API URL (media links in tool results are mapped back to `SENSEPLANE_API_URL`) |
| `MCP_PUBLIC_URL` | `http://localhost:58060` | Public MCP base URL; must match what clients see. Set it on the `api` too: the console shows it for connecting apps. |
| `MCP_CONSOLE_URL` | `CONSOLE_URL` | The console's public URL: people approve apps on its `/connect` page (required in production) |
| `MCP_TRUSTED_REDIRECT_HOSTS` | none | Comma-separated redirect hosts the consent page calls verified (e.g. `claude.ai`); every other host gets a "not verified" warning |
| `MCP_TOKEN_SECRET` | dev default | OAuth token secret (required in production) |
| `TRUST_PROXY` | off | Set `1` behind a reverse proxy |

`MCP_ALLOW_OWNER_KEYS` is gone: the consent page no longer takes keys, so
there is nothing to relax. Clients that send `Authorization: Bearer sk_…`
directly still work with any key.

**Connecting an app** (ADR 0048): an MCP client's Connect opens the console's
consent page, where an admin or owner signs in, picks cameras, sensors and
permissions, and allows. Senseplane creates an agent named after the client
with those grants and its own key, which never leaves the servers; the app
appears under **Agents**, where its access can be changed or the app
disconnected (which ends its tokens on their next use). Connecting the same
app again from the same redirect host reuses that agent.

## Sign-in and teams

The console signs people in with an email and password, and with Google or
GitHub when you set their OAuth credentials (`AUTH_GOOGLE_*`, `AUTH_GITHUB_*`;
see `api/README.md`). Set `CONSOLE_URL` to your console's address: sign-in
returns there and invite links open there.

**Sign-up** is open in development and closed in production mode unless you
set `AUTH_SIGNUP`: `open`, `closed`, or `first`, where only the first person
to sign up does (they own the new workspace) and sign-up then closes by
itself. The [one-file setup](self-host-vm.md) uses `first`. With it closed,
create the first user with the CLI:

```sh
docker compose -f deploy/compose/docker-compose.yml exec -e SENSEPLANE_PASSWORD='a long password' \
  api node dist/cli.js create-user <account_id> you@example.com
```

`create-user <account_id> <email> [owner|admin|member|viewer]` also adds an
existing user to another account. `reset-password <email>` sets a new password
(from `SENSEPLANE_PASSWORD`).

**Teams.** Everyone else joins through an invite: in the console, **Settings →
Team → Invite someone** gives a single-use link (valid 7 days,
`AUTH_INVITE_DAYS`) to send yourself; no email is sent. The invited person signs
up with that address even when sign-up is closed, or signs in if they already
have an account, and can then switch between their workspaces. Roles:

| Role | Can |
|---|---|
| Viewer | See cameras, live view, events, watches, history and usage. Change nothing. |
| Member | Also create and change watches, clips and conversations, and ask cameras questions. |
| Admin | Everything else: cameras, connecting apps (MCP consent), agents and keys, webhooks, team, settings, export. |
| Owner | Also delete the workspace and make or remove owners. A workspace always keeps one owner. |

Roles apply to people signed in to the console. API keys keep their own rules:
account keys have full access, agent keys only their grants. Invites, role
changes and removals are in the audit log.

## IP cameras and the bridge

IP cameras reach Senseplane through the bridge (`bridge/`, ADR 0045), a small
Go program that runs next to the cameras and connects out to your Senseplane:

- It needs HTTPS to the API (`API_PUBLIC_URL`) and WebRTC to the media plane
  (`MEDIA_PUBLIC_URL` plus `MEDIA_RTC_PORT`, TCP and UDP, at
  `MEDIA_ANNOUNCED_ADDRESS`). Nothing connects to the bridge.
- The image is `ghcr.io/senseplane-ai/bridge` (set `BRIDGE_IMAGE` to name
  another, e.g. one you built with `docker build -t my/bridge bridge`). Run
  the command a new `rtsp` source returns:

  ```sh
  docker run -d --restart unless-stopped --name senseplane-bridge ghcr.io/senseplane-ai/bridge:0.1 \
    --api https://senseplane.example.com --token brg_… --rtsp rtsp://user:pass@192.168.1.40:554/stream1
  ```

- One bridge carries many cameras: add them with `"bridge_id"` and
  `"rtsp_url"` on `POST /v1/sources`, or with more `--rtsp` flags. It picks up
  changes within a minute.
- Camera URLs (with their passwords) are stored encrypted with
  `SECRETS_ENCRYPTION_KEY` and only sent back to the bridge.
- Cameras must stream H.264; nothing is re-encoded. Audio from bridge
  cameras isn't recorded.
- A bridge on the same Docker host as the media plane can push to it
  directly with `--whip-base http://media:8090` (the address it can reach).
- `POST /v1/sources/{id}/ingest-token` gives the bridge a new token (every
  camera on it reconnects once the bridge runs with it);
  `DELETE` revokes it.

## Home Assistant and other sensors

Sensor sources take readings pushed with their integration token (`sit_…`):
from the Home Assistant integration (`integrations/home-assistant`) or any
script (`POST /v1/sources/{id}/readings`). The token can push readings to its
own source and nothing else. Readings follow the same retention days as
footage (the source's, else the account's).

## TLS and a reverse proxy

Browsers only allow the camera on HTTPS pages, and remote MCP clients need
HTTPS. The [one-file setup](self-host-vm.md) puts Caddy in front of everything
on one domain (`deploy/selfhost/Caddyfile`: the console at `/`, the API at
`/v1`, `/auth` and `/api/`, MCP at `/mcp` and `/oauth`, WHIP at `/whip`,
signalling at `/signal/`). To run your own proxy instead, put it in front of:

- the **API** (`api:8080`), for example `https://api.example.com`;
- **media signalling** (`media:8090`, with WebSocket upgrades), for example
  `https://media.example.com`;
- the **MCP server** (`mcp:8060`), for example `https://mcp.example.com`;
- the **console** (build it with `pnpm --filter @senseplane/console build` and
  serve `console/dist`), for example `https://console.example.com`.

Then set the public URLs to match: `API_PUBLIC_URL`, `CAPTURE_URL`
(`https://console.example.com/capture.html`), `MEDIA_PUBLIC_URL`,
`MCP_PUBLIC_URL` (on `api` and `mcp`), `MCP_CONSOLE_URL`, `CONSOLE_URL`,
`SENSEPLANE_PUBLIC_API_URL`, `CORS_ORIGINS`, and `TRUST_PROXY=1`. Build the
console with `VITE_MCP_URL=https://mcp.example.com/mcp` or let it read
`MCP_PUBLIC_URL` from the API.

**Don't proxy** the WebRTC port (40000): expose it TCP/UDP directly with
`MEDIA_ANNOUNCED_ADDRESS` set to the server's public IP. `/control/*` on the
media listener only accepts single-use tokens signed with the API's key, so
it may share the proxied listener; keep it internal if you can.

A minimal Caddyfile:

```
api.example.com     { reverse_proxy api:8080 }
media.example.com   { reverse_proxy media:8090 }
mcp.example.com     { reverse_proxy mcp:8060 }
console.example.com { root * /srv/console; file_server }
```

The API and MCP server limit requests per key and per IP (`RATE_LIMIT_*`
above). Limits are per process, so with several replicas add a limit at the
proxy too.

## Object storage

The bundled store is **RustFS** (Apache 2.0, S3-compatible), with data in the
`s3data` volume. You can use any S3-compatible service instead: point
`S3_ENDPOINT`, `S3_BUCKET`, credentials and `S3_REGION` at it on `api` (the
media plane has no storage credentials: it uploads through presigned URLs),
and set `S3_FORCE_PATH_STYLE=false` if your provider uses
virtual-hosted URLs. Senseplane uses put, get, delete, presigned URLs and
(optionally) lifecycle rules.

Layout: raw footage under `raw/{account_id}/{source_id}/…`, clips under
`clips/{account_id}/…`. Deleting expired raw footage is done by the API's
retention sweeper; the optional lifecycle rule is only a backstop.

## Retention

- Raw footage is kept for `retention_days`: per account (default
  `RAW_RETENTION_DAYS`, 7) and optionally per source. Change it with
  `PATCH /v1/account` or `PATCH /v1/sources/{id}`.
- Clips, events and snapshots are kept until you delete them.
- Sensor readings follow the same days (source, else account); with no
  retention days set they are kept until deleted.
- Lowering retention deletes older raw footage at the next sweep.
- Keep retention as short as your purpose allows (see
  [Lawful camera use](lawful-use.md#keep-footage-only-as-long-as-you-need-it)).

## Backups

- **Postgres** holds accounts, sources, watches, events, the segment index and
  the audit log. Valkey holds only working state (frames in flight, brain
  events not yet stored, live viewers) and rebuilds itself; its AOF volume
  (`valkeydata`) survives restarts. Back it up regularly:
  ```sh
  docker compose -f deploy/compose/docker-compose.yml exec -T postgres \
    pg_dump -U senseplane -Fc senseplane > senseplane-$(date +%F).dump
  ```
- **Object storage** holds footage, clips and snapshots. Back up `clips/` (kept
  forever) and anything else you can't afford to lose, with your storage's
  replication or a tool like `rclone`. Raw footage expires anyway, so backing
  it up is optional.
- Restore Postgres and object storage from the same point in time: the segment
  index must match the stored objects.

## An external media plane

The API talks to the media plane only through the media contract, so it can
use one that runs elsewhere: see [external-media-plane.md](external-media-plane.md).

## Upgrades

```sh
git pull
docker compose -f deploy/compose/docker-compose.yml --profile app up -d --build
```

- Read the release notes and decision records (`docs/decisions/`) first.
- Back up Postgres before upgrading. Migrations run automatically when the
  API starts and are forward-only.
- Restarting the media plane interrupts streaming sources. Their recordings
  show a gap in the timeline, and capture pages may need reopening.

## Monitoring

Every service exposes `/healthz` and Prometheus metrics (`/metrics`), and
writes JSON logs.
Watch especially:

- the media plane's memory (one feed egress per streaming source);
- the brains' load and the API's balancer (`sp:brains`, ADR 0052);
- webhook delivery failures (`GET /v1/webhooks/{id}/deliveries`);
- `source.offline` events.
