# 5. Postgres 17 with pgvector; no TimescaleDB

Date: 2026-10-15 · Status: accepted · The NATS note is superseded by ADR 0051 (Valkey)

## Decision
One Postgres 17 database with the `vector` extension. Sensor readings go in a
natively partitioned table (monthly partitions, BRIN index on time).
TimescaleDB is dropped: v1 volumes don't need it, its key features are under
the Timescale License rather than Apache, and plain Postgres keeps any managed
offering an option.

Only the API service connects to Postgres. Media and brain use NATS (and NATS
KV for compiled watches and zones).
