#!/bin/sh
# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
#
# Runs once on first start. The API runs migrations as the owner role and
# connects at runtime as senseplane_app, a non-superuser, so row-level
# security applies (superusers bypass RLS). The app role's password comes
# from APP_DB_PASSWORD (deploy/compose/.env, made by init-secrets.sh).
set -eu
psql -v ON_ERROR_STOP=1 -v app_pw="${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
SELECT format('CREATE ROLE senseplane_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'app_pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'senseplane_app') \gexec
GRANT CONNECT ON DATABASE senseplane TO senseplane_app;
GRANT USAGE ON SCHEMA public TO senseplane_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO senseplane_app;
SQL
