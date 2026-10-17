#!/usr/bin/env bash
# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
#
# Starts a built image and checks it works without the rest of the stack:
#   scripts/smoke-image.sh <api|mcp|media|console|brain|bridge> <image>
# CI runs it on every image it builds (.github/workflows/ci.yml).
set -euo pipefail

service=${1:?service}
image=${2:?image}
name="smoke-${service}-$$"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Runs the service, then waits for its /healthz from inside the container.
serve() {
  local port=$1
  shift
  docker run -d --name "$name" "$@" "$image" >/dev/null
  for _ in $(seq 1 60); do
    if docker exec "$name" node -e "fetch('http://127.0.0.1:${port}/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
      echo "$service: /healthz ok"
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then break; fi
    sleep 1
  done
  echo "$service: no healthy /healthz; logs:" >&2
  docker logs "$name" 2>&1 | tail -n 40 >&2
  return 1
}

case "$service" in
  api)
    # The self-host init step: writes every service's secrets and env files.
    docker run --rm --user 0:0 --entrypoint /bin/sh -e SENSEPLANE_DOMAIN=localhost "$image" \
      -c 'node dist/selfhost.js /tmp/secrets >/dev/null && test -s /tmp/secrets/api.env && test -s /tmp/secrets/caddy.env'
    # The server's imports resolve (telemetry preload included); it needs Postgres to go further.
    docker run --rm --entrypoint node "$image" --import @senseplane/telemetry/register --input-type=module \
      -e "await import('/app/dist/createApi.js'); console.log('api: modules load')"
    ;;
  mcp)
    serve 8060 -e MCP_TOKEN_SECRET=smoke-test-secret
    ;;
  media)
    # Starts a mediasoup worker (the native binary for this architecture) and the LGPL FFmpeg.
    docker run --rm --entrypoint /bin/sh "$image" -c 'ffmpeg -hide_banner -version | head -n 1 && ! ffmpeg -hide_banner -buildconf | grep -E -- "--enable-(gpl|nonfree)"'
    # The development key pair's public half (deploy/compose), not a secret.
    serve 8090 -e MEDIA_INSTANCE_ID=smoke -e MEDIA_ANNOUNCED_ADDRESS=127.0.0.1 -e MEDIA_WORKERS=1 \
      -e MEDIA_TOKEN_PUBLIC_KEYS=dev-1:LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUNvd0JRWURLMlZ3QXlFQXhzell4NlZESzJLSldMamxtejNCeWVNMFNqem1wdWI3SmxIZHJRdE44bGs9Ci0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQo=
    ;;
  console)
    docker run --rm --entrypoint /bin/sh -e SENSEPLANE_DOMAIN=localhost -e CADDY_TLS="tls internal" "$image" \
      -c 'test -s /srv/index.html && out=$(caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1) || { echo "$out"; exit 1; }; echo "$out" | tail -n 1'
    ;;
  brain)
    # The baked models load in ONNX Runtime on this architecture, the int8 detector included.
    docker run --rm "$image" /app/.venv/bin/python -c "
import pathlib, onnxruntime as ort
from senseplane_brain import models
for key in ('yolox_s', 'yolox_s_int8', 'yolox_tiny'):
    p = models.path(key)
    assert p.exists(), p
    ort.InferenceSession(str(p), providers=['CPUExecutionProvider'])
print('brain: models load', sorted(f.name for f in pathlib.Path(models.MODELS_DIR).iterdir()))
"
    ;;
  bridge)
    docker run --rm "$image" -h 2>&1 | grep -- "-healthcheck" >/dev/null
    echo "bridge: binary runs"
    ;;
  *)
    echo "unknown service: $service" >&2
    exit 2
    ;;
esac
