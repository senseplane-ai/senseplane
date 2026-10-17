# 6. Kysely for queries; tenancy enforced by row-level security

Date: 2026-10-15 · Status: accepted

## Decision
- Kysely (MIT) with `kysely-codegen`-style generated types and Kysely
  migrations, owned by the API service. No ORM.
- Every account-scoped table has `account_id`, `ENABLE` and `FORCE ROW LEVEL
  SECURITY`, and a policy comparing `account_id` to
  `current_setting('app.account_id')`.
- The API runs each request in a transaction that sets `app.account_id` with
  `set_config(..., true)` (transaction-local).
- Migrations run as the owner role; the app connects as `senseplane_app`, a
  non-superuser, because superusers bypass RLS.

## Consequences
A query that forgets `WHERE account_id = ...` still cannot read another
account's rows. A test proves cross-account reads return nothing and
cross-account writes are rejected.
