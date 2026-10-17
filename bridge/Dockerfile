# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
# Build from bridge/: docker build -t ghcr.io/senseplane-ai/bridge:dev .
# Published as ghcr.io/senseplane-ai/bridge (docs/dev/releasing.md).
# A static binary on distroless (no shell, runs as nonroot). ADR 0045.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X github.com/senseplane-ai/senseplane/bridge/internal/health.Version=${VERSION}" -o /out/bridge ./cmd/bridge

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/bridge /bridge
USER nonroot:nonroot
# Outbound only: /healthz and /metrics listen on 127.0.0.1 inside the container (BRIDGE_LISTEN to change).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/bridge", "--healthcheck"]
ENTRYPOINT ["/bridge"]
