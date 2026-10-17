# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
# The console, served by Caddy (Apache 2.0) as the self-host stack's front door
# (deploy/selfhost/Caddyfile). Build from the repo root: docker build -f console/Dockerfile .
# The build is the same for every domain: the console calls the API on its own
# origin (/api/v1) and learns the MCP address from the API at runtime.
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY console/package.json console/
COPY sdk/typescript/package.json sdk/typescript/
RUN pnpm install --filter "@senseplane/console..." --frozen-lockfile
COPY sdk/typescript sdk/typescript
COPY console console
RUN pnpm --filter "@senseplane/console..." build

FROM caddy:2.11.4-alpine
LABEL org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build /repo/console/dist /srv
COPY deploy/selfhost/Caddyfile /etc/caddy/Caddyfile
