# Run Senseplane on a VM

One machine, one file, HTTPS on your own domain. You edit a few settings at
the top of `docker-compose.yml` and run `docker compose up -d`. Everything
else (certificates, passwords, keys, the public addresses) is set up for you.

Before you point cameras at people, read [Lawful camera use](lawful-use.md).

## What you need

- **A Linux VM** (Ubuntu 24.04 or Debian 12 are fine) with a public IP.
  - **4 vCPU, 8 GB RAM** for up to about 4 cameras. A few quiet cameras run
    on 2 vCPU.
  - **Disk:** 30 GB for the system and images, plus about 11 GB per camera per
    day of footage kept at 720p (7 days by default: about 80 GB per camera).
- **A domain name** with a DNS **A record** pointing at the VM's public IP,
  for example `cams.example.com`.
- **Open ports** in your provider's firewall (and in `ufw` if you use it):

  | Port | Protocol | For |
  |---|---|---|
  | 80 | TCP | Certificate checks, redirect to HTTPS |
  | 443 | TCP (and UDP, optional) | The console, API, MCP and signalling |
  | 40000 | UDP and TCP | Video from cameras (WebRTC). Not proxied |

- **A model endpoint** (optional at first): any OpenAI-compatible API and its
  key, for example [OpenRouter](https://openrouter.ai). Questions and the
  model check on watches need it. Detection, recording and watches work
  without it.

## 1. Install Docker

On the VM:

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER      # then log out and back in
docker compose version             # v2.24 or newer
```

## 2. Get Senseplane

All you need is one file:

```sh
mkdir senseplane && cd senseplane
curl -fsSLO https://raw.githubusercontent.com/senseplane-ai/senseplane/main/docker-compose.yml
```

The images are pulled from `ghcr.io/senseplane-ai` when it starts.

## 3. Edit the settings

Open `docker-compose.yml` and edit the block at the top. Nothing else in the
file needs changing.

```yaml
x-settings: &settings
  SENSEPLANE_DOMAIN: cams.example.com
  SENSEPLANE_EMAIL: you@example.com
  AI_BASE_URL: https://openrouter.ai/api/v1
  AI_API_KEY: "sk-or-…"
  AI_MODEL_VISION: anthropic/claude-haiku-5.5
  AI_MODEL_TEXT: anthropic/claude-sonnet-5.5
  RAW_RETENTION_DAYS: "7"
  MEDIA_ANNOUNCED_ADDRESS: ""
```

| Setting | What it is |
|---|---|
| `SENSEPLANE_DOMAIN` | Your domain. Its A record must point at this VM. `localhost` (the default) runs a local try |
| `SENSEPLANE_EMAIL` | Contact for the Let's Encrypt certificate (optional) |
| `AI_BASE_URL`, `AI_API_KEY` | Your model endpoint and key. With no key, questions are off and watches fire without a model check. A local server that needs no key (Ollama) takes any value, such as `none` |
| `AI_MODEL_VISION`, `AI_MODEL_TEXT` | The models, as your endpoint names them. The vision model must accept images |
| `RAW_RETENTION_DAYS` | How long raw footage is kept by default |
| `MEDIA_ANNOUNCED_ADDRESS` | Leave empty. Set it to the VM's public IP only if your domain doesn't resolve to it (see [Troubleshooting](#video-doesnt-connect)) |

### Secrets

All of them are in the same block:

- **`POSTGRES_PASSWORD`, `VALKEY_PASSWORD`, `S3_ACCESS_KEY`,
  `S3_SECRET_KEY`**: the database, Valkey and object storage passwords. The
  file ships with defaults: change them before real use. These services are
  only reachable inside the machine. Changing one later takes effect on the
  next `docker compose up -d`.
- **`AI_API_KEY`**: your model endpoint's key.
- **`AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET`** and
  **`AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET`** (optional): turn on
  "Sign in with GitHub / Google". Create an OAuth app at the provider with the
  callback `https://cams.example.com/auth/oauth/github/callback` (or
  `/google/callback`) and paste its ID and secret. Leave them empty for email
  and password only.

The signing and encryption keys (playback links, MCP tokens, stored webhook
secrets, the media signing key) are generated on first start (below), unique
to your install, and never shown: a shared default for those would let anyone
forge links or tokens. Secrets that belong to a watch or an integration, such as a Slack
webhook URL or a webhook's signing secret, are entered in the console and
stored encrypted in the database.

Each service gets only the secrets it needs: the model key reaches the brain
alone, the sign-in secrets the API alone.

The file now holds your keys, so make it private:

```sh
chmod 600 docker-compose.yml
```

## 4. Start it

```sh
docker compose up -d
docker compose ps        # every service "healthy" (caddy just "Up")
```

On first start, a one-shot `init` service creates the signing and encryption
keys into the `secrets` volume, together with your passwords from the
settings. Later starts keep the keys; nothing is rotated. Its log shows what
it set up (never the secrets):

```sh
docker compose logs init
# senseplane: https://cams.example.com (Let's Encrypt certificate)
# senseplane: media announces 203.0.113.7, WebRTC on port 40000 (UDP and TCP)
```

Check it from anywhere:

```sh
curl https://cams.example.com/healthz          # {"status":"ok"}
curl https://cams.example.com/healthz/mcp
curl https://cams.example.com/healthz/media
```

## 5. Create your account

Open `https://cams.example.com` and choose **Create an account**. The first
person to sign up owns the workspace. After that, sign-up closes by itself.
Add your team from **Settings → Team → Invite someone**: invites always work.

## 6. Add a camera

In the console, press **Add phone or laptop camera** and scan the QR code with
your phone (or open the link on a laptop). Allow the camera and keep the page
open with the screen on. The camera shows as online in a few seconds, and
someone walking past gives a `detection.person` event.

IP cameras (RTSP) connect through the bridge, a small container on the
cameras' network that connects out to your domain: see
[Self-hosting](self-host.md#ip-cameras-and-the-bridge).

## 7. Connect Claude or another agent (MCP)

Your MCP server is at `https://cams.example.com/mcp`.

- **Claude (claude.ai, Claude Desktop):** Settings → Connectors → Add custom
  connector, with that URL.
- **Claude Code:**
  `claude mcp add --transport http senseplane https://cams.example.com/mcp`,
  then `/mcp` and connect.

Senseplane's consent page opens: sign in, choose which cameras and what the
agent may do, and press **Allow**. More clients: [MCP setup](mcp-setup.md).

For code (REST API, SDK, webhooks), the API is at
`https://cams.example.com/v1`. Create a key under **Agents → For developers**.

## Upgrade

Back up first (below). Then:

```sh
docker compose pull
docker compose up -d
```

The images follow a release line (`:0.1`), so this brings every 0.1.x
release. A new line (0.2) comes with release notes and a new
`docker-compose.yml`: copy your settings block into it.

Migrations run when the API starts. Secrets and data stay in their volumes.

## Change a setting

Edit the block and run `docker compose up -d` again. The `init` step runs
again and the services restart with the new values. Changing the domain gets a
new certificate; capture links made for the old domain stop working.

## Back up

Everything lives in Docker volumes (`docker volume ls`; their names start
with `senseplane-server_`):

| Volume | Holds | Back up? |
|---|---|---|
| `secrets` | The signing and encryption keys | **Yes.** Without it stored webhook secrets can't be read and playback links and agent tokens stop working |
| `pgdata` | Accounts, cameras, events, the recording index | **Yes** (pg_dump below) |
| `s3data` | Footage, clips, snapshots | Clips and anything you want to keep |
| `caddy-data` | Certificates | Optional (they are issued again) |
| `valkeydata` | Working state | No |

```sh
# The database
docker compose exec -T postgres pg_dump -U senseplane -Fc senseplane > senseplane-$(date +%F).dump
# The secrets (keep this file private)
docker run --rm -v senseplane-server_secrets:/s:ro -v "$PWD":/b alpine tar czf /b/secrets-$(date +%F).tgz -C /s .
# Footage and clips
docker run --rm -v senseplane-server_s3data:/s:ro -v "$PWD":/b alpine tar czf /b/storage-$(date +%F).tgz -C /s .
```

Restore the database and the storage from the same point in time: the
recording index must match the stored footage.

## Logs

```sh
docker compose logs -f api        # or caddy, media, brain, mcp, init
docker compose logs --since 10m
```

## Troubleshooting

### No certificate, or the browser warns

- `docker compose logs caddy` says why.
- The A record must point at this VM (`dig +short cams.example.com`), and
  ports 80 and 443 must be open to the internet: Let's Encrypt checks over
  port 80 or 443.
- Too many failed attempts hit Let's Encrypt's rate limits; fix DNS or the
  firewall, then wait an hour.
- With `localhost` or an IP address as the domain, Caddy uses its own
  certificate, which browsers warn about. That is expected for a local try.

### `init` exits with an error

`docker compose logs init`. "doesn't resolve" means the A record isn't there
yet (or hasn't spread): add it and run `docker compose up -d` again, or set
`MEDIA_ANNOUNCED_ADDRESS`.

### Video doesn't connect

The capture page stays on "Connecting…": the browser can't reach port 40000.

- Open 40000 **UDP and TCP** in the cloud firewall and on the VM.
- The media plane announces the address your domain resolves to
  (`docker compose logs init`). Behind a load balancer or a proxy such as
  Cloudflare's orange cloud, that isn't the VM: set `MEDIA_ANNOUNCED_ADDRESS`
  to the VM's public IP. Port 40000 can't go through a web proxy.

### Watches and questions don't work

`AI_API_KEY` is empty or wrong. `docker compose logs init` says
"no AI_API_KEY" when it is empty, and `docker compose logs brain` shows model
errors. Set it in the settings and run `docker compose up -d`.

### Sign-up says it is closed

Someone already signed up. Ask the owner for an invite. If you are the owner
and forgot your password:

```sh
docker compose exec -e SENSEPLANE_PASSWORD='a new long password' api \
  sh -c 'set -a && . /secrets/api.env && node dist/cli.js reset-password you@example.com'
```

## Try it on your own computer

Leave `SENSEPLANE_DOMAIN: localhost`, run `docker compose up -d` and open
`https://localhost` (accept the certificate warning). A laptop camera works.
A phone can't use `localhost`: put your computer's LAN IP as the domain
instead and accept the warning on the phone.

If ports 80, 443 or 40000 are taken on your computer, put other ones in a
`.env` file next to `docker-compose.yml` (local testing only):

```sh
SENSEPLANE_HTTP_PORT=8080
SENSEPLANE_HTTPS_PORT=8443
SENSEPLANE_RTC_PORT=40100
```

and open `https://localhost:8443`.

## More

- [Self-hosting reference](self-host.md): every variable, scaling brains, the
  bridge, object storage, retention.
- [Run against an external media plane](external-media-plane.md).
- Build from source instead of pulling: in a clone of the repository,
  `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.
- Contributors: the development stack is `deploy/compose/docker-compose.yml`
  ([quick start](quickstart.md)).
