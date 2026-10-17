# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
FROM python:3.12-slim
# Time zone data for watch schedules (zoneinfo; ADR 0043).
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src src
COPY scripts scripts
RUN uv sync --frozen --no-dev
# Pinned, checksummed model artefacts (YOLOX, YAMNet, MiniLM; Apache 2.0), baked into the image. The int8 detector
# is built here from yolox_s (the quantize group: onnx, sympy), which the second sync removes again.
ENV SENSEPLANE_MODELS_DIR=/app/models
RUN uv sync --frozen --no-dev --group quantize && /app/.venv/bin/python scripts/fetch_models.py && uv sync --frozen --no-dev
USER nobody
EXPOSE 8070
CMD ["/app/.venv/bin/python", "-m", "senseplane_brain"]
