# Senseplane docs

Eyes and ears for your agent. Connect the cameras, microphones and sensors you
already have; your agent sees, hears and remembers what happens.

## Start here

- **[Run Senseplane on a VM](self-host-vm.md):** one file, your domain,
  HTTPS; `docker compose up -d`.
- **[Quick start](quickstart.md):** the development stack: run Senseplane,
  stream a camera, create a watch and receive a webhook, in about ten minutes.
- **[Connect an agent with MCP](mcp-setup.md):** Claude (Desktop, Code,
  claude.ai), Cursor and any other MCP client.
- **[Lawful camera use](lawful-use.md):** read this before pointing a camera
  at anyone.

## Build with Senseplane

- **[API guide](api/README.md):** authentication, errors, pagination, events,
  webhooks and signature checks, agents and grants.
- **API reference:** every endpoint with sample requests and responses,
  generated from [`spec/openapi.yaml`](../spec/openapi.yaml). Build it with
  `pnpm docs:build` and open `docs/site/api.html`.
- **[MCP tools](api/mcp-tools.md):** the 10 tools agents use.
- **[Detector labels](api/labels.md):** what the cameras spot by themselves: people, vehicles, animals and 64 everyday objects.
- **[Watch spec](watch-spec.md):** how a plain-language watch becomes a
  trigger.
- **[Asking about time](activity.md):** how long, how often, since when and
  compared with usual, from activities; tracking watches, condition and
  digest watches, and packs.
- **[Telegram](telegram.md):** watch alerts in a Telegram chat, and questions
  asked from it.

## Run it yourself

- **[Run Senseplane on a VM](self-host-vm.md):** the one-file setup.
- **[Load-test your server](load-test.md):** how many cameras it takes, from
  your own computer.
- **[Self-hosting](self-host.md):** requirements, configuration, production
  secrets, TLS, storage, retention, backups and upgrades.
- **[Test with a real phone](dev/phone-testing.md)** on your local network.

## How it works

- **[Architecture](architecture.md):** the layers and the contracts between
  them.
- **[Media signalling protocol](../spec/media/signalling.md):** how capture
  clients publish to the media plane.
- **[Roadmap](roadmap.md).**
- **[Decision records](decisions/):** why things are the way they are.
- **[Milestone results](milestones/):** what each milestone delivered and how
  it was tested.

## Building this site

```sh
pnpm install
pnpm docs:build      # → docs/site/ (index.html, api.html, …)
```

The API reference is rendered with [Redoc](https://github.com/Redocly/redoc)
(MIT licence) through Redocly CLI (MIT), and the guides with
[marked](https://github.com/markedjs/marked) (MIT). The MCP tools page is
regenerated from `spec/mcp/tools.json` on every build.
