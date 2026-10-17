# One media contract, Valkey, the brain balancer (2026-10-17)

Done-when: *the API drives any media plane through one contract with only
configuration differing; NATS is gone; frames from a camera reach exactly one
brain, which can fail without losing the camera; the open-source media server
passes a black-box conformance suite in CI.*

## What was built

- **One media contract** (ADR 0049, `spec/media`): the control API
  (`/control/*`: rooms, participants, egress, healthz, usage), Ed25519 tokens
  (join `aud: media`, single-use control `aud: control`, WHIP `aud: whip`)
  with golden vectors, signalling, WHIP with an `authorize_url`, and the
  callbacks (room events, feed events, presigned uploads, frames batches).
  One protocol version; newest connection replaces the older one, except a
  plain-transport ingress, which is refused.
- **Open-source media server** (ADR 0050): one image with ingress and egress
  roles (`MEDIA_ROLES`). A camera's feed is an egress participant writing ~6 s
  fMP4 segments through presigned PUTs and posting ≤ 5 JPEGs + 1 s of audio a
  second; no bus, no database, no bucket credentials. The resolution limit is
  refused before anything is stored.
- **API media driver**: rooms and feeds are ensured when a token is issued,
  feeds stop after `FEED_IDLE_STOP_SECONDS` offline, on pause, delete and
  allowance; callbacks are bearer-checked and idempotent; privacy masks are
  applied to frames in the API before any brain sees them; live viewer counts
  and idle timeouts live in the API (`media_feeds`, migration 0023).
- **Valkey replaces NATS** (ADR 0051, `spec/brain/valkey.json`): capped frame
  streams per brain, a durable event stream with a consumer group and dead
  letters, request/reply, keys with change notification; AOF in Compose.
- **Sticky brain balancer** (ADR 0052): brains heartbeat their load; the API
  assigns each camera to the least busy live brain with a compare-and-set,
  reassigns a dead brain's cameras within about 10 s, rebalances gently, and
  shares cooldown markers so a takeover never alerts twice.
- **Brain tuning** (ADR 0054, [brain-tuning.md](brain-tuning.md)): adaptive
  detection rate, −16 % CPU per camera at unchanged accuracy and latency.
- **Conformance suite** (ADR 0053, `conformance/`): tokens, control,
  signalling (headless Chrome publisher and viewers), WHIP, feed egress
  against a mock callback and bucket, the replace rule.

## Results

| Check | Result |
|---|---|
| Conformance vs the open-source media server | tokens 34, control 24, signalling 14, whip 14, feed 19: all pass |
| Media tests (`pnpm --filter @senseplane/media test`) | 92 pass |
| Brain CPU per camera (yolox_s) | 1.342 → 1.125 cores, precision/recall 1.0/1.0, person latency unchanged |

Run against another media plane: [external-media-plane.md](../external-media-plane.md).
