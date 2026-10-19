# 58. Background work shared through Postgres

Date: 2026-10-19 · Status: accepted

## Context

Every API process ran the same 30-second timer: closing stale activities,
expiring watches, checking condition and digest watches (ADR 0057), purging
accounts, usage limits and more. Webhook deliveries and event clips were read
by every process with no lock. With one process that is fine. With several,
every process did all the work, a repeating condition watch could fire twice
(its event key used the time of the check, and nothing locked the watch
between reading and writing `last_condition`), and two processes could send
the same webhook.

## Decision

**Postgres is the queue.** Each piece of due work is a row, and a process
claims it with `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`,
setting a lease (`claimed_until`). Other processes skip locked and leased
rows. Finishing clears the lease in the same transaction as the work's own
writes. A process that dies leaves its lease to run out, and another takes the
row over. The database's `now()` is the clock, so the processes' clocks don't
matter. Owner-defined functions claim across accounts, like the sweeps before
them.

- **Jobs** (`scheduled_jobs`, one row per job: interval, lease, next run,
  last error, state): housekeeping. `claim_jobs` registers the process's jobs
  and claims the due ones; `finish_job` sets the next run a full interval on
  and keeps the job's state (the usage-limits job keeps which accounts were
  over, to resume their watches). Processes poll at half the shortest
  interval, between 1 and 10 s, with jitter.
- **Scheduled watches** (`watches.next_check_at`). A trigger sets it to "due
  now" when a condition or digest watch is created, edited or resumed, and
  clears it when the watch stops being one or is paused. After each check
  the checker sets the exact next time: the next `at` on an allowed day, in
  the watch's time zone, or `every_min` on, moved to when the watch's hours
  and days next allow. Changing the workspace's time zone makes them due
  again so it is worked out afresh. Polled every 5 s: a daily check is at
  most a few seconds late, and a poll with nothing due is one index lookup.
- **Webhook deliveries** and **event clips**: claimed with a lease
  (`claim_webhook_deliveries`, `claim_event_clips`) instead of read by
  everyone. Deliveries are polled every second and woken at once in the
  process that created them.

`API_WORKERS=false` makes a process serve requests only. One process (self
host) does everything; a larger deployment runs request processes with it off
and a few worker processes with it on, and adds worker processes to share
more work.

**Why not BullMQ (Valkey).** The work is tied to rows in Postgres: an event
and its deliveries are written in one transaction, and a watch's schedule is
part of the watch. A queue in Valkey would need an outbox to stay consistent
with those writes, and a second copy of every watch's schedule to keep in
sync on every edit, pause, limit and deletion. Per-recipient rate limits
(Telegram) are a column in Postgres; in BullMQ they need the paid edition.
Valkey stays for what it is good at: frames, the brain's streams and the
balancer.

**Time.** Every time column is `timestamptz`. Local times (a 20:00 digest,
"nights") are turned into instants in code with the time zone's rules. In a
skipped hour (clocks going forward) a time moves forward by the gap; in a
repeated hour it is the earlier one, as the brain's `zoneinfo` does. The one
SQL function that cut time by the session's zone (monthly sensor reading
partitions) is pinned to UTC.

## Consequences

- Nothing runs twice, and a process can be added or removed at any time.
- A crashed process's work waits for its lease: 1 minute for a delivery,
  2 for a scheduled watch, 5 by default for a job.
- Jobs are visible in one table, with when each last ran and its last error.
- The interval is from the end of one run to the start of the next, so a
  slow job drifts later rather than piling up.
- Postgres carries a few small claim queries per second per worker process,
  well within what it handles.
