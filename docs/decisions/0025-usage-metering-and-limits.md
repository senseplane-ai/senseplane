# 25. Usage metering and limits

Date: 2026-10-16 · Status: accepted · Amended by ADR 0029 (hard and notify limits, `allowance_exhausted`); segment events arrive as media callbacks since ADR 0049

## Decision
**Meters** (usage records, per account, per source where it applies):

| Meter | From | Unit |
|---|---|---|
| Camera-minutes, per resolution | `media.segment.written` (duration, coded width/height) | seconds, stored as `camera_seconds` with detail `720p`/`1080p`/`other` |
| Storage | an hourly sample of stored bytes (raw segments, clips, snapshots) | GB-hours (`storage_gb_hours`, one sample per account per hour, idempotent) |
| AI checks, by kind | `brain.usage` (`ai_checks`, detail `verify`/`look`/`ask`/`summary`/`compile`) | calls |
| Frames analysed, model cost | `brain.usage` | as before |

`GET /v1/usage?from&to` (default: this UTC month) sums them, with a per-day
breakdown and the current registered/active source counts against limits.

**Limits** come from the quota provider (`Quota`), unlimited unless a
deployment sets them:

- `maxRegisteredSources` (`QUOTA_MAX_SOURCES`): `POST /v1/sources` → 409
  `source_limit_reached`.
- `maxActiveSources` (`QUOTA_MAX_ACTIVE_SOURCES`): `POST /v1/capture/join`
  → 409 `source_limit_reached` when that many sources are streaming; the join
  token carries `grants.maxActiveSources` and the media plane refuses a
  `produce` beyond it with the same code (it counts its own live sessions; the
  API's check is the cross-node one). The capture page says "Your plan's
  camera limit is reached".
- **Usage limits** (`Quota.usageLimits`, e.g. AI checks per day or month,
  camera-minutes, storage GB): checked by the API's sweeper every 30 s. Over
  the AI-check limit, watches pause and `ask`/`look` refuse with
  `quota_exceeded`; over camera-minutes or storage, capture is refused and
  live sources are disconnected. A module can also implement
  `onUsageLimit(accountId, meter)` for alerts.

## Consequences
- Metering is exact for ingest and AI (event counts), sampled for storage
  (hourly; the error is at most one hour of growth).
- The default open-source install meters but never limits.
