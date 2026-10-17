#!/bin/sh
# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
# Creates the bucket. When RAW_RETENTION_MAX_DAYS is set, also adds a
# lifecycle backstop on raw/ one day past it. The index sweeper is the
# authoritative deleter (ADR 0016); this rule only catches what it misses.
set -eu
aws="aws --endpoint-url ${S3_ENDPOINT}"
for i in $(seq 1 30); do $aws s3api list-buckets >/dev/null 2>&1 && break; sleep 1; done
$aws s3api head-bucket --bucket "${S3_BUCKET}" 2>/dev/null || $aws s3api create-bucket --bucket "${S3_BUCKET}"
if [ -n "${RAW_RETENTION_MAX_DAYS:-}" ]; then
  days=$((RAW_RETENTION_MAX_DAYS + 1))
  $aws s3api put-bucket-lifecycle-configuration --bucket "${S3_BUCKET}" --lifecycle-configuration \
    "{\"Rules\":[{\"ID\":\"raw-backstop\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"raw/\"},\"Expiration\":{\"Days\":${days}}}]}"
  echo "lifecycle backstop: raw/ expires after ${days} days"
else
  echo "no RAW_RETENTION_MAX_DAYS set: no lifecycle backstop (sweeper only)"
fi
echo "bucket ${S3_BUCKET} ready"
