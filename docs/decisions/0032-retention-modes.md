# 32. Retention modes: days or fill

Date: 2026-10-17 · Status: accepted (updates ADR 0016)

## Context
ADR 0016 kept raw footage for a number of days per account, with per-source
overrides. Usage-based deployments also want "keep as much as my storage
allows", and some owners want footage kept until they delete it.

## Decision
- Per account, with an optional per-source override, `retention_mode` is:
  - `days` (default): keep raw footage for `retention_days` (default 7). A null
    number of days keeps it until deleted, unless the quota provider caps days.
  - `fill`: keep as much raw footage as a byte cap holds, deleting the oldest
    first. The cap is `retention_max_bytes`, or the quota provider's
    `storageCapBytes` when unset. Fill mode is refused without any cap.
- A source in fill mode with its own `retention_max_bytes` is capped alone.
  Sources that follow the account's fill mode share the account cap, minus the
  bytes of clips and snapshots, which are kept until deleted in both modes.
- The sweeper (the only deleter of raw footage) runs days mode as before and
  then fill mode, using the segment index's byte counts. Clips are separate
  copies and are never touched.
- Snapshots now record their size (`events.snapshot_bytes`) and count in the
  storage meter, closing the gap noted in M6.
- `GET /v1/account` reports `storage` (raw, clip and snapshot bytes, raw growth
  per day over the last week, the cap, and estimated days at current usage);
  the console shows "≈ X days at current usage".

## Consequences
In fill mode the history length varies with activity. A busy camera keeps fewer
days than a quiet one; the estimate makes that visible.
