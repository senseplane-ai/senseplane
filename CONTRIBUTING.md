# Contributing to Senseplane

Thanks for helping give agents eyes and ears.

## Ground rules

- **Spec first.** Change `spec/` before changing the API, SDKs or MCP tools.
  Run `pnpm codegen` and commit the generated files; CI fails on drift.
- **Layers stay independent.** Services talk only through the documented
  Valkey keys and streams (`spec/brain/valkey.json`), the media contract
  (`spec/media`) and the public API. Only the API service connects to Postgres.
- **No transcoding in the media path.** If something seems to need it, open an
  issue first.
- **Every service** exposes `/healthz`, structured JSON logs and Prometheus
  metrics, and is configured through environment variables documented in its README.
- **Licences.** New dependencies must be MIT, BSD, ISC, Apache 2.0 or MPL 2.0.
  Add attribution to `NOTICE` when required. Every source file starts with:

  ```
  // Copyright 2026 The Senseplane Authors
  // SPDX-License-Identifier: Apache-2.0
  ```

- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org/).
  Keep pull requests small, one concern each, with user docs updated in the same PR.
- **Significant choices** get a short ADR in `docs/decisions/`.

## Local setup

Requirements: Node 24, pnpm 10, Python 3.12 with uv, Go 1.24, Docker.

```sh
pnpm install
docker compose -f deploy/compose/docker-compose.yml up -d   # Postgres, Valkey, RustFS
pnpm -r build && pnpm -r test
(cd brain && uv sync && uv run pytest)
(cd bridge && go test ./...)
```

Tests that need Postgres, Valkey or object storage read `TEST_ADMIN_DATABASE_URL`,
`TEST_VALKEY_URL` and `TEST_S3_ENDPOINT` (the compose defaults otherwise) and are
skipped with a note when the service isn't reachable. The Valkey tests default
to a password-less Valkey on `redis://127.0.0.1:47379` (a separate db per
package, flushed), as in CI: `docker run -d -p 47379:6379 valkey/valkey:8.1.4-alpine`.

**Media contract:** `node conformance/src/oss.ts` runs the black-box media
contract suite against the open-source media server (`conformance/README.md`).

**End to end:** `pnpm e2e` builds its own stack (compose project `sp-e2e`,
ports 38xxx), runs every check in `e2e/` against it, then drives the console
in Chrome at 1440 and 390 px, prints a pass/fail table and tears the stack
down. `pnpm e2e --only chat,live` runs a subset, `--keep` leaves the stack up.
Model answers are replayed from `e2e/fixtures/model-replay.json`;
`E2E_LIVE_MODEL=1` records them again with the model in your `.env`. Logs and
screenshots land in `e2e/.artifacts/`. Needs Go, ffmpeg and Chrome
(`CHROME_PATH`).

## Continuous integration

Every pull request and every push to `main` runs `.github/workflows/ci.yml`;
a pull request merges once its `ci-ok` check is green. In parallel it runs:

- **repo:** actionlint on the workflows, and `node scripts/version.mjs check`
  (image tags name the release line of the version in `package.json`).
- **node:** `pnpm check:licenses`, `pnpm check:drift`, `pnpm build` (every
  package and the docs site; generated docs must be committed), then
  `pnpm test` against Postgres (pgvector), Valkey and RustFS service containers.
- **brain:** `uv run pytest` with the models fetched and the int8 detector built
  (`uv run --group quantize python scripts/fetch_models.py`), cached between runs.
- **bridge:** gofmt, `go vet`, `go test`, `go build`.
- **home-assistant:** the integration's pytest suite.
- **conformance:** the media contract suite against the bundled media server in Chrome.
- **images:** every image builds and starts (`scripts/smoke-image.sh`).
- **dependency-review** (pull requests): known vulnerabilities and licences of added dependencies.

`pnpm e2e` runs in `.github/workflows/e2e.yml` after every merge, nightly and on
demand (Actions → e2e → Run workflow, optionally with `only`). Images are
published by `.github/workflows/release.yml`: see
[docs/dev/releasing.md](docs/dev/releasing.md).
