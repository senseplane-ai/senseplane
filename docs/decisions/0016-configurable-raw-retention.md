# 16. Raw retention is configurable per account and per source

Date: 2026-10-15 · Status: accepted · Updated by ADR 0032 (retention modes)

## Decision
- **Account:** `retention_days` (raw video and audio), default 7.
  `GET/PATCH /v1/account`. Self-host default comes from `RAW_RETENTION_DAYS`
  with no upper limit; a deployment can set a maximum per account through the
  quota provider (`Quota.maxRetentionDays`).
- **Source:** optional `retention_days` override on `PATCH /v1/sources/{id}`;
  `null` means "use the account value". It is capped by the same maximum.
- **Deletion:** the API's index sweeper is authoritative. It deletes raw
  segments (objects and index rows) older than the effective retention, so
  lowering the value takes effect at the next sweep. Clips and derived data
  are never touched by it.
- **Backstop:** a storage lifecycle rule on `raw/` at the instance maximum + 1
  day (`RAW_RETENTION_MAX_DAYS`) catches anything the sweeper misses. When no
  maximum is set (self-host default), there is no backstop rule.
- Storage is metered in GB-days (usage records).

Exceeding the maximum returns `quota_exceeded`.
