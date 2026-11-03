# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
# Build from the repo root: docker build -f api/Dockerfile .
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY api/package.json api/
COPY telemetry/package.json telemetry/
RUN pnpm install --filter "@senseplane/api..." --frozen-lockfile
COPY telemetry telemetry
COPY api api
RUN pnpm --filter "@senseplane/api..." build && pnpm --filter @senseplane/api deploy --prod --legacy /out

FROM node:24-slim
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 8080
# Telemetry is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (docs/observability.md).
CMD ["node", "--import", "@senseplane/telemetry/register", "dist/server.js"]
