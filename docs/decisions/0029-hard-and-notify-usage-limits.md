# 29. Hard and notify usage limits

Date: 2026-10-17 · Status: accepted

## Context
ADR 0025 made every usage limit a stop. A deployment may want two behaviours:
an allowance that stops usage when it runs out, and an allowance past which
usage carries on and is only reported.

## Decision
- `UsageLimit.enforcement`: `"hard"` (default, the ADR 0025 behaviour) or
  `"notify"`.
- Hard limits: over an AI-check limit, watches pause and `ask` / `POST /watches`
  answer `429 allowance_exhausted`; over camera time or storage, `capture/join`
  answers `429 allowance_exhausted` and live cameras are disconnected with the
  `roomClosed` reason `allowance_exhausted`, which the capture page explains.
- Notify limits never block; `onUsageLimit` fires for both kinds.
- New public error code `allowance_exhausted`. `quota_exceeded` stays for
  settings above a limit (such as retention) and demo budgets.
- The media control API's disconnect takes an optional `reason`.

## Consequences
The open-source default (no limits) is unchanged. A deployment chooses per
limit whether running out stops usage or is only reported.
