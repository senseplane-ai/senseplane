# Senseplane

**Eyes and ears for your agent.**

[Website](https://senseplane.com) · [Docs](docs/README.md) · [Run it on a VM](docs/self-host-vm.md) · [Connect an agent](docs/mcp-setup.md) · [API](docs/api/README.md)

Connect the cameras, microphones and sensors you already have, and any agent
(Claude, ChatGPT, Cursor or your own code) can see, hear and remember what
happens.

- **Look:** a snapshot of what's there now, and questions about it.
- **Watch:** "tell me when a package is left at the door", with events by signed webhook, MCP or Telegram.
- **Ask:** "when did the courier come?", answered with the event, a snapshot and a clip.
- **Measure:** "how many meals today?", "how long did she sleep?", "is it quieter than usual?", answered exactly from activities, with a daily summary if you want one.
- **Replay:** any range within your retention period (7 days by default).

Senseplane does perception, not decisions: it reports what it saw, how sure it
is and the evidence, and your agent decides what to do. Agents connect through
an MCP server, a REST API, webhooks and a TypeScript SDK.

> **Status:** early (v0.1). Expect rough edges, and please
> [report what breaks](https://github.com/senseplane-ai/senseplane/issues).

## Quick start

On a server or your own computer with [Docker](https://docs.docker.com/engine/install/):

```sh
mkdir senseplane && cd senseplane
curl -fsSLO https://raw.githubusercontent.com/senseplane-ai/senseplane/main/docker-compose.yml
# edit the settings block at the top: your domain, email, passwords and (optionally) a model key
chmod 600 docker-compose.yml
docker compose up -d
```

Open `https://<your domain>` and create your account (the first one owns the
workspace). Add a phone or laptop camera from the console, then connect your
agent to `https://<your domain>/mcp`. The full guide, with DNS, firewall,
backups and upgrades: [Run Senseplane on a VM](docs/self-host-vm.md).

## How it fits together

| Part | Folder | Language | Role |
|---|---|---|---|
| Media plane | `media/` | TypeScript (mediasoup) | Ingest, continuous recording, playback, analysis feed |
| Brain | `brain/` | Python | Motion, objects, sounds, episodes, watches, memory |
| API | `api/` | TypeScript (Fastify) | Public `/v1` REST API, webhooks, auth |
| MCP server | `mcp/` | TypeScript | 10 tools for agents |
| SDK | `sdk/typescript/` | TypeScript | `npm i senseplane` |
| Console | `console/` | TypeScript (React) | Web UI for sources, playback, watches, chat, access |
| Bridge | `bridge/` | Go | RTSP cameras, outbound only |
| Home Assistant | `integrations/home-assistant/` | Python | Forwards sensors as readings |
| Spec | `spec/` | OpenAPI + JSON Schema | Single source of truth for API, SDK and MCP |

Everything runs on one machine from [one compose file](docker-compose.yml),
with Caddy in front for HTTPS. More: [architecture](docs/architecture.md),
[roadmap](docs/roadmap.md), [decisions](docs/decisions/) and
[lawful camera use](docs/lawful-use.md).

## Contributing

The development stack and a ten-minute tour of the API, webhooks and MCP are in
the [quick start for contributors](docs/quickstart.md); see also
[CONTRIBUTING.md](CONTRIBUTING.md). To build and test everything:

```sh
pnpm install
docker compose -f deploy/compose/docker-compose.yml up -d   # Postgres, Valkey, object storage
pnpm -r build && pnpm -r test
pnpm docs:build                                              # docs site in docs/site/
```

Security issues: see [SECURITY.md](SECURITY.md).

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The Senseplane name is a
trademark; forks must rename (see [TRADEMARKS.md](TRADEMARKS.md)).
