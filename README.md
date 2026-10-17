# Senseplane

**Eyes and ears for your agent.**

Connect the cameras, microphones and sensors you already have. Your agent can
see, hear and remember what happens: real video, not just labels.

- **Look:** a snapshot of what's there now.
- **Watch:** "tell me when a package is left at the door", with events by signed webhook.
- **Ask:** "when did the courier come?", answered with the event, a snapshot and a clip.
- **Replay:** any range within your retention period (7 days by default).

Senseplane does perception, not decisions: it reports facts, confidence and
evidence, and your agent decides what to do. Agents connect through a REST API,
webhooks, an MCP server and a TypeScript SDK.

> **Status:** early development. Not ready for production use yet.

**Documentation:** start with the [docs index](docs/README.md): [run it on a
VM](docs/self-host-vm.md), the [quick start](docs/quickstart.md), [MCP setup](docs/mcp-setup.md),
[API guide](docs/api/README.md), [self-hosting](docs/self-host.md) and
[lawful camera use](docs/lawful-use.md).

## How it fits together

| Layer | Folder | Language | Role |
|---|---|---|---|
| Media plane | `media/` | TypeScript (mediasoup) | Ingest, continuous recording, playback, analysis feed |
| Brain | `brain/` | Python | Motion, objects, sounds, episodes, watches, memory |
| API | `api/` | TypeScript (Fastify) | Public `/v1` REST API, webhooks, auth |
| MCP server | `mcp/` | TypeScript | 8 tools for agents |
| SDK | `sdk/typescript/` | TypeScript | `npm i senseplane` |
| Console | `console/` | TypeScript (React) | Web UI for sources, playback, watches, access |
| Bridge | `bridge/` | Go | RTSP cameras, outbound-only |
| Home Assistant | `integrations/home-assistant/` | Python | Forwards sensors as readings |
| Spec | `spec/` | OpenAPI + JSON Schema | Single source of truth for API, SDK and MCP |

The open-source edition runs on a single machine with `docker compose`
([one file](docker-compose.yml), Caddy in front for HTTPS).
See [`docs/architecture.md`](docs/architecture.md) for how it fits together,
[`docs/roadmap.md`](docs/roadmap.md) for what comes next and
[`docs/decisions/`](docs/decisions/) for architecture decisions.

## Quick start

Run Senseplane on a server (or your own computer) over HTTPS with one file:

```sh
mkdir senseplane && cd senseplane
curl -fsSLO https://raw.githubusercontent.com/senseplane-ai/senseplane/main/docker-compose.yml
# edit the settings block at the top: your domain, your model key
chmod 600 docker-compose.yml
docker compose up -d
```

Then open `https://<your domain>` and create your account. The full guide,
with DNS, firewall, backups and upgrades: [Run Senseplane on a VM](docs/self-host-vm.md).

**Contributors:** the development stack and a ten-minute tour of the API,
webhooks and MCP are in [docs/quickstart.md](docs/quickstart.md). To build and
test everything:

```sh
pnpm install
docker compose -f deploy/compose/docker-compose.yml up -d   # Postgres, Valkey, object storage
pnpm -r build && pnpm -r test
pnpm docs:build                                              # docs site in docs/site/
```

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The Senseplane name is a
trademark; forks must rename (see [TRADEMARKS.md](TRADEMARKS.md)).
