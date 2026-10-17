# 30. Idempotency-Key on create routes

Date: 2026-10-17 · Status: accepted

## Context
The spec declared an `Idempotency-Key` header but nothing used it. Agents and
scripts retry on timeouts, and a retried create would make a second source,
watch, clip, webhook or grant.

## Decision
- `POST /v1/sources`, `/watches`, `/clips`, `/webhooks` and `/grants` accept an
  optional `Idempotency-Key` (1–255 characters), scoped to the account.
- The first response (any status below 500) is stored for 24 hours. A retry
  with the same key and body gets it back with `Idempotent-Replayed: true`. The
  same key with a different body or route is refused: `422
  idempotency_key_reused`. Requests that fail validation are not stored.
- The table is account-isolated by row-level security; an hourly job deletes
  keys older than 24 hours.
- The TypeScript SDK's create calls take `{ idempotencyKey }`.

## Consequences
Two identical requests racing with the same key can both run before either is
stored; the stored response is the first to finish. Good enough for retries;
not a lock.
