# 51. Valkey replaces NATS

Date: 2026-10-17 · Status: accepted · Supersedes the NATS parts of ADR 0002, 0033, 0041

## Context

NATS (JetStream, KV, core request/reply) connected the media server, the API,
the brain and MCP. With the media contract (ADR 0049) the media plane no
longer talks to anything but the API over HTTP, so what is left is the API's
private traffic with its brains and MCP: a frames feed, a durable event log
with retries, request/reply to any free brain, a few small key-value buckets,
and shared state for the brain balancer (ADR 0052). One store that also
exists as a managed service covers all of it, the same in every deployment.

## Decision

Valkey (BSD-3-Clause, the `valkey/valkey` image) is the one store between the
API, the brain and MCP, with persistence (AOF) on. Clients: ioredis (MIT) in
the API and MCP, redis-py (MIT) in the brain. No Redis server images (7.4 and
later are not open source). The contract is `spec/brain/valkey.json`:

| What | Was | Now |
|---|---|---|
| Frames and audio for the brain | core NATS `frames.*.*` / `audio.*.*` (every brain got every frame) | capped stream `sp:frames:{brain_id}`: only the camera's brain reads it; newest frame per camera wins, frames older than 3 s are dropped |
| Brain events and usage | JetStream stream `BRAIN`, durable consumer, nak + redelivery (max 20) | stream `sp:brain:events`, consumer group `api`, XACK after storing, XAUTOCLAIM after 2 s idle, dead-letter after 20 deliveries |
| compile, ask, embed, check, chat | core NATS request/reply, queue group `brain` | list `sp:rpc:brain` (BRPOP by a brain with a free slot), replies on `sp:rpc:reply:{api_instance}`, deadlines dropped |
| Chat streaming and tool calls | `{inbox}.event`, `{inbox}.tool` | lists `{stream}:events` and `{stream}:tool:{call_id}` |
| KV `sources`, `watches`, `views` | JetStream KV buckets with watchers | hashes `sp:sources`, `sp:watches`, `sp:views` + channel `sp:changed`; the brain reloads on connect |
| KV `snapshots` | JetStream KV | `sp:snapshot:{account}.{source}`, 24 h expiry |
| MCP OAuth code redemption | KV bucket `mcp_oauth_grants` | `SET NX EX` on `sp:mcp:used:*` / `sp:mcp:revoked:*` |

The media plane's events no longer go through a bus: they are HTTP callbacks
the API answers after writing them (a 5xx makes the media plane retry), which
replaces the `MEDIA` stream.

Settings: `VALKEY_URL` in the API, brain and MCP. Compose runs `valkey` with
`--appendonly yes` and a password in production (`VALKEY_PASSWORD`).

## Consequences

- One fewer service (NATS is gone). Any Valkey-compatible managed store
  works in its place.
- A frame reaches one brain, not every brain, so adding brains adds capacity.
- Valkey is a single point for the brain path. With AOF it survives a restart
  with events in flight; a Valkey outage stops analysis and brain RPCs but not
  ingest, recording or the public API.
- Pub/sub is used only where a lost message is harmless (RPC replies the
  caller times out on, change notifications followed by a full reload on
  reconnect).
