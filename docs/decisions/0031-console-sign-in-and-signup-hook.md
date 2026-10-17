# 31. Console sign-in and the sign-up hook

Date: 2026-10-17 · Status: accepted; memberships, roles and invites: ADR 0044; `AUTH_SIGNUP=first`: ADR 0056

## Context
The console only accepted a pasted API key, and accounts could only be made
with the setup CLI. People need to sign in, a public instance needs sign-up,
and a deployment needs a say over who may sign up and on what terms.

## Decision
- `/auth` next to `/v1` (spec: `spec/auth/openapi.yaml`): email and password
  (scrypt), plus "Continue with Google" and "Continue with GitHub" when their
  OAuth client credentials are set. Both providers are optional and off by
  default.
- A console session is an API key that expires (`api_keys.expires_at`, default
  30 days); everything else in the API is unchanged. Sign-out revokes it.
- Sign-up is closed unless `AUTH_SIGNUP=open`. Self-host accounts come from
  `senseplane-admin create-account` and `create-user`. An existing user can
  always sign in with a password or a linked provider.
- A provider sign-in with a verified email that matches an existing user links
  the provider to that user instead of creating an account.
- **Hook:** modules implement `onSignup(request)` and return allow (optionally
  with a plan label), refuse (`403 signup_refused` with the module's message),
  or no opinion. The request carries the method, normalised email, whether the
  provider verified it, the provider id and public profile facts (GitHub
  creation date, repositories, followers), IP, user agent, a first-party
  browser token and an optional challenge token. `onAccountCreated` follows.
- `accounts.plan` stores the label for the deployment's quota provider.
- Users and provider identities are a global directory (sign-in looks them up
  before any account is known), so they are not row-isolated like account data.
- Sign-in endpoints are rate limited per IP (10 a minute, per instance).

## Consequences
No email verification or password reset by email yet (no mail sending in the
open-source bundle); `senseplane-admin reset-password` covers self-host.
Several API replicas each keep their own rate-limit window.

## Addendum (2026-10-17)

"Sign in with an API key" is removed from the console (ADR 0048): people sign
in with a password or a provider; API keys are for code only. A self-hosted
instance with sign-up closed gets its first user from `create-account` and
`create-user`.
