#!/bin/sh
# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
#
# Creates deploy/compose/.env with random credentials for every internal
# service (Postgres, the app role, Valkey, object storage, the media signing
# key pair, service secrets). Docker Compose reads this file automatically.
# Existing values are kept, so it is safe to run again (and after an upgrade,
# to add new ones). Never commit the generated file.
set -eu
cd "$(dirname "$0")"
ENV_FILE=.env
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

rand() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
b64() { base64 | tr -d '\n'; }
put() {
  if ! grep -q "^$1=" "$ENV_FILE"; then
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

put SP_PG_PASSWORD "$(rand)"
put SP_APP_DB_PASSWORD "$(rand)"
put SP_S3_ACCESS_KEY "sp$(rand | cut -c1-18)"
put SP_S3_SECRET_KEY "$(rand)"
put VALKEY_PASSWORD "$(rand)"
put MCP_TOKEN_SECRET "$(rand)"
put PLAYBACK_SIGNING_SECRET "$(rand)"

# The API signs media tokens with an Ed25519 key; the media plane trusts its
# public half (spec/media/tokens.md, ADR 0049). One kid, written once.
if ! grep -q "^MEDIA_SIGNING_KEY=" "$ENV_FILE"; then
  kid="sp-$(rand | cut -c1-8)"
  key=$(mktemp)
  trap 'rm -f "$key"' EXIT
  openssl genpkey -algorithm ed25519 -out "$key" 2>/dev/null
  printf 'MEDIA_SIGNING_KEY=%s:%s\n' "$kid" "$(b64 <"$key")" >>"$ENV_FILE"
  printf 'MEDIA_TOKEN_PUBLIC_KEYS=%s:%s\n' "$kid" "$(openssl pkey -in "$key" -pubout 2>/dev/null | b64)" >>"$ENV_FILE"
  rm -f "$key"
fi

echo "Wrote $(pwd)/$ENV_FILE (credentials are not printed)."
