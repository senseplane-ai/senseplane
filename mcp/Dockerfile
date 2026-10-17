# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY mcp/package.json mcp/
COPY sdk/typescript/package.json sdk/typescript/
COPY telemetry/package.json telemetry/
RUN pnpm install --filter "@senseplane/mcp..." --frozen-lockfile
COPY sdk/typescript sdk/typescript
COPY telemetry telemetry
COPY mcp mcp
RUN pnpm --filter "@senseplane/mcp..." build && pnpm --filter @senseplane/mcp deploy --prod --legacy /out

FROM node:24-slim
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 8060
# Telemetry is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (docs/observability.md).
CMD ["node", "--import", "@senseplane/telemetry/register", "dist/server.js"]
