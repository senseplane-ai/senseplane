# 13. RustFS for self-host object storage

Date: 2026-10-15 · Status: accepted

## Context
MinIO was the first choice for self-host. In M0, `minio/minio` could no longer
be pulled from Docker Hub (404), and MinIO is AGPL-3.0.

## Decision
The compose bundle uses **RustFS** (`rustfs/rustfs:1.0.0`, Apache 2.0,
S3-compatible, 1.0 GA since September 2026, lifecycle rules supported). A
setup job (AWS CLI, Apache 2.0) creates the `senseplane` bucket and, when
`RAW_RETENTION_MAX_DAYS` is set, a lifecycle backstop on `raw/` (ADR 0016).
Senseplane only uses the S3 API, so any S3-compatible store works through
`S3_ENDPOINT` (AWS S3 or any S3-compatible store).

## Rejected
- **MinIO:** AGPL-3.0, and community images are no longer published.
- **SeaweedFS** (used briefly in M0): Apache 2.0, but runs as separate master,
  volume and filer services and sets expiry through its own shell rather than
  standard S3 lifecycle rules. RustFS is a single binary that behaves like MinIO.
