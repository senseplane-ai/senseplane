# Architecture

Senseplane gives AI agents eyes and ears: it ingests cameras, microphones and
sensors, records continuously, perceives what happens, and answers agents
through a REST API, webhooks, an MCP server and an SDK. Everything here runs on
one machine with `docker compose`; every layer is built to scale out
horizontally.

## Layers

| Layer | Folder | Role | Talks to |
|---|---|---|---|
| Media plane | `media/` | WebRTC and WHIP ingest (mediasoup), live view, and each camera's feed egress: H.264 copied into ~6 s fMP4 segments (never transcoded) and analysis frames and audio | Only the callbacks the API gives it (presigned uploads, frames, events); its control API for the API |
| Brain | `brain/` | Motion, objects, sounds, episodes, watches, the model adapter, embeddings | Valkey |
| API | `api/` | Public `/v1` REST API, auth, webhooks, playback, privacy masks, the brain balancer, the only owner of Postgres | Postgres, Valkey, object store, media control API |
| MCP server | `mcp/` | 10 tools for agents over stdio or remote HTTP | API |
| SDK | `sdk/typescript/` | `npm i senseplane`, generated from the spec | API |
| Console | `console/` | Web UI for sources, playback, watches, search, access | API, media signalling |
| Bridge | `bridge/` | Outbound-only relay for RTSP cameras (ADR 0045) | API (config, health), media plane (WHIP) |

**Only the API connects to Postgres** (17, with pgvector; row-level security on
every account table). The media plane knows nothing of Senseplane: the API
creates a room and a feed egress per camera through the media contract, the
feed's frames come back to the API, which applies privacy masks and passes them
to the one brain the sticky balancer assigned the camera to (ADR 0052). API and
brain talk over Valkey (ADR 0051): capped frame streams, a durable event
stream with a consumer group, request/reply, and keys for watches, zones and
live state.

## Contracts

All contracts live in [`spec/`](../spec/) and are checked in CI:

- `spec/openapi.yaml` and `spec/schemas/*.json`: the public REST API and the
  shared schemas (SDK, brain and MCP types are generated from them).
- `spec/media/`: the one media contract (ADR 0049): the control API, tokens
  and golden vectors, the WebSocket signalling protocol, WHIP, and the
  callbacks. `conformance/` checks a media plane against it (ADR 0053).
- `spec/brain/valkey.json`: the Valkey keys, streams and messages between API
  and brain.
- `spec/mcp/`: the MCP tool definitions.

## Extension points

- **`createApi(options)`** (ADR 0007): the API is a library. A deployment can
  register **modules** (extra routes, served on the public or an internal-only
  listener), an **audit sink**, a **usage sink** that receives every usage
  record, and a **quota provider** (`quotaFor(accountId)`: max sources, model
  calls per day, max raw retention, max recording resolution, usage
  allowances, live view on/off and viewers at once, a plan label).
- **Media plane** (ADR 0002, 0049): anything that implements the media
  contract and passes the conformance suite can replace `media/`; only
  configuration differs ([external-media-plane.md](external-media-plane.md)).
- **Models** (ADR 0008): any OpenAI-compatible endpoint, for example
  OpenRouter or a local model, with the model per task set in config.
- **Object storage**: any S3-compatible store (RustFS in compose, ADR 0013).
  `S3_PUBLIC_ENDPOINT` lets players fetch segments with presigned URLs
  instead of streaming them through the API (ADR 0018).

## Self-hosting

`docker-compose.yml` at the repository root runs Postgres, Valkey, RustFS, the
API, the media plane, the brain, the MCP server and the console behind Caddy
on one domain ([Run Senseplane on a VM](self-host-vm.md), ADR 0056);
`deploy/compose/docker-compose.yml` is the development stack. Production mode
(`NODE_ENV=production` or `SENSEPLANE_MODE=production`) refuses development
defaults such as a missing or development `MEDIA_SIGNING_KEY` or a Valkey
without a password. Retention, quotas,
the recording resolution (`QUOTA_MAX_RESOLUTION`, 720p by default) and the
demo limits are environment variables.

## Decisions

Architecture decisions are in [`decisions/`](decisions/); milestone results in
[`milestones/`](milestones/); the roadmap in [`roadmap.md`](roadmap.md).
