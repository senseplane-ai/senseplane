# Repository layout

This repo (`senseplane-ai/senseplane`, Apache 2.0) holds everything needed to
self-host Senseplane. Each layer builds, tests and releases independently.

```
senseplane/
├── api/               # Fastify REST API (/v1), webhooks, auth; only Postgres owner
├── media/             # Open-source mediasoup media plane (ingress + egress roles, one image)
├── brain/             # Python: signal, perception, episodes, watches, VLM, memory
├── mcp/               # MCP server (10 tools)
├── console/           # Web console (React), also the capture page
├── sdk/
│   └── typescript/    # npm: senseplane
├── bridge/            # Go relay for RTSP cameras (outbound only)
├── integrations/
│   └── home-assistant/  # forwards Home Assistant sensors as readings
├── spec/
│   ├── openapi.yaml   # public REST API
│   ├── schemas/       # JSON Schemas shared by API, SDK, brain, MCP
│   ├── mcp/           # MCP tool definitions
│   ├── brain/         # valkey.json: the Valkey keys, streams and messages between API and brain
│   └── media/         # the media contract: control API, tokens + vectors, signalling, WHIP, callbacks
├── conformance/       # black-box media contract suite (headless Chrome), run against media/ in CI
├── docker-compose.yml # the one-file self-host setup (docs/self-host-vm.md)
├── deploy/compose/    # the development stack (docker compose)
├── deploy/selfhost/   # the Caddyfile used by the one-file setup
├── e2e/               # end-to-end checks (pnpm e2e)
├── telemetry/         # shared OpenTelemetry setup for the Node services
├── fixtures/          # short test clips for perception tests
└── docs/              # architecture, roadmap, ADRs (docs/decisions/), milestone results
```
