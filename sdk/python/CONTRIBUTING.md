# Contributing to the Python SDK

The repository's [CONTRIBUTING.md](../../CONTRIBUTING.md) applies; this covers
what is particular to `sdk/python`.

## What is generated

One command regenerates everything, from `sdk/python`:

```sh
uv run python scripts/codegen.py
```

(`pnpm codegen` at the repository root runs it with the other generators.) It writes:

| File | From |
|---|---|
| `src/senseplane/_generated/models.py` | `spec/openapi.yaml`, by datamodel-code-generator (Pydantic v2) |
| `src/senseplane/_generated/api.py` | `spec/openapi.yaml` (operations, which take an Idempotency-Key) and `spec/schemas` (error codes, senses) |
| `src/senseplane/_generated/labels.py` | `spec/labels.json` |
| `src/senseplane/_generated/tools.json` | `spec/mcp/tools.json` |
| `src/senseplane/_sync_client.py`, `_sync_tools.py` | `_async_client.py`, `_async_tools.py`, by dropping `async` and `await` |

Don't edit generated files. The async client and tools are the hand-written
source: change them and regenerate, and the sync versions follow. In them,
don't write the word "await" in comments or docstrings (the rewrite would drop
it), and use `asyncio.sleep` for sleeping (it becomes `time.sleep`).

CI regenerates and fails on any difference (`pnpm check:drift`), so commit the
regenerated files with the change.

## A new endpoint

1. Add it to `spec/openapi.yaml` and regenerate.
2. Add a method to the resource in `_async_client.py`, calling the operation by
   its `operationId`; regenerate again for the sync client.
3. `tests/test_client.py::test_every_spec_operation_has_a_method` fails until
   every operation in the spec has a method.

## Tests

```sh
uv run pytest                                          # unit tests (no network)
SENSEPLANE_INTEGRATION=1 uv run pytest -m integration  # against a real API
```

The integration tests start the API from `api/dist` (build it first:
`pnpm --filter "@senseplane/api..." build`) with `scripts/integration-api.mjs`,
on a fresh database on the test Postgres (`TEST_ADMIN_DATABASE_URL`, as in
`api/vitest.config.ts`) and db 12 of the test Valkey, on a port in 42000–42999,
and drop the database afterwards. Set `SENSEPLANE_TEST_API_URL` and
`SENSEPLANE_TEST_API_KEY` to run them against an API you started yourself.

`tests/fixtures/webhook-vectors.json` comes from the TypeScript SDK
(`node scripts/webhook-vectors.mjs` after `pnpm --filter senseplane build`), so
both SDKs verify signatures the same way.

## Dependencies

Runtime: httpx (BSD) and pydantic (MIT) only. Every dependency, dev tools
included, must be MIT, BSD, ISC, Apache-2.0 or MPL-2.0 (typing-extensions,
under the PSF licence, comes with pydantic); `uv run python scripts/check_licenses.py`
checks the synced environment.
