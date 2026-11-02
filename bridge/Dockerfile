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
RUN mkdir -p /out/data

# The Home Assistant add-on (ADR 0061): the same binary, as root because the
# Supervisor mounts /data (the add-on's options and the paired token) owned by
# root. It pairs with a code and serves its panel on 8099 (ingress).
# Published as ghcr.io/senseplane-ai/bridge-addon.
FROM gcr.io/distroless/static-debian12 AS addon
COPY --from=build /out/bridge /bridge
LABEL io.hass.type="addon" io.hass.name="Senseplane"
ENV BRIDGE_LISTEN=0.0.0.0:8099
ENTRYPOINT ["/bridge"]

# The bridge container (the default target).
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/bridge /bridge
# Where a box paired with a code keeps its token (ADR 0061): owned by nonroot,
# so a named volume mounted here starts writable.
COPY --from=build --chown=nonroot:nonroot /out/data /data
ENV SENSEPLANE_STATE_DIR=/data
USER nonroot:nonroot
# Outbound only: /healthz and /metrics listen on 127.0.0.1 inside the container (BRIDGE_LISTEN to change).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/bridge", "--healthcheck"]
ENTRYPOINT ["/bridge"]
