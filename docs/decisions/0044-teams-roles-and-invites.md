# 44. Teams, roles and invites

Date: 2026-10-16 · Status: accepted

## Context
ADR 0031 tied each user to exactly one account, and every console session had
full access. A workspace needs several people with different powers, a way to
bring them in without opening sign-up to everyone, and people who belong to
more than one workspace. A local stack should also sign up like a real user.

## Decision
- **Memberships** (`memberships`: account, user, role) replace the one-account
  user. Roles: `owner`, `admin`, `member`, `viewer`. Every existing user owns the
  account they were created in. `users.account_id` now only remembers the last
  workspace used (sign-in opens it, else the oldest membership); deleting a
  workspace no longer deletes its people.
- **Sessions remember their user** (`api_keys.user_id`). The key lookup returns
  the user's current role, so a role change or removal applies on the next
  request, and a removed member's sessions also end at once. Existing sessions
  are kept when their account had one user; others sign in again.
- **Enforcement** (`api/src/roles.ts`), for console sessions only, before body
  validation: reads are open to viewers except the audit log, invites and
  export downloads (admin); writes need admin unless listed. Members may
  create, change and delete watches (incl. backtests), clips and conversations,
  ask cameras and give event feedback. Viewers may only manage their own
  session (switch, name, leave) and open live view. Deleting the workspace is
  owner-only. Unknown write routes fail closed as admin-only. Refusals are 403
  `forbidden_role` with the role and the role needed.
- **Owner rules:** only an owner makes, changes or removes owners or invites
  one; the last owner can't be demoted, removed or leave (409 `conflict`,
  `details.reason: last_owner`). Ownership is "transferred" by making someone
  else an owner, then stepping down.
- **API keys keep their own rules:** account keys act as an owner (as before),
  agent keys only their grants (ADR 0024). `GET /v1/me` with an API key answers
  `user: null, role: owner`.
- **Invites:** `POST /v1/invites {email, role}` (admin) returns a single-use
  link `<console>/#invite=<token>` (fragment, so it stays out of server logs),
  valid 7 days (`AUTH_INVITE_DAYS`). Only a hash is stored, so the link is shown
  once; inviting the same address again withdraws the earlier link. No email is
  sent. `GET /auth/invites/{token}` tells the accept page what to ask for;
  `POST /auth/invites/{token}/accept` signs in (password or an existing
  session) or signs up, then joins, atomically marking the invite used.
  Google/GitHub accept via `?invite=` on `/auth/oauth/{provider}/start`; the
  provider's verified email must be the invited address. Another address is 403
  (`wrong_email`); used, withdrawn or expired links are 410 `invite_invalid`.
- **Invited people may always sign up**, even with sign-up closed: they join an
  existing workspace instead of creating one, so the `onSignup` hook (which
  decides account creation and plans) isn't asked.
- **Switching workspace:** `GET /v1/me` lists memberships; `POST /v1/me/switch`
  issues a session in another workspace and ends the current one.
- **Account settings:** `accounts.time_zone` (IANA, default `UTC`), set with
  `PATCH /v1/account`. Users gain an optional `name` (`PATCH /v1/me`).
- **Limits and audit:** invite preview and accept share the per-IP sign-in
  limit (10 a minute); invites are limited per workspace (30 an hour, per
  instance). Invite created, accepted, withdrawn, role changes, removals,
  leaving and workspace switches are written to the audit log with details,
  besides the usual per-request entries.
- **Development sign-up:** `AUTH_SIGNUP` unset means open outside production
  mode and closed in production (`SENSEPLANE_MODE`/`NODE_ENV=production`);
  `open` or `closed` choose explicitly. Compose passes `AUTH_SIGNUP`,
  `SENSEPLANE_MODE` and `CONSOLE_URL` (default: the console origin).
- `senseplane-admin create-user <account> <email> [role]` adds a membership;
  for an existing user it just joins them to the account.

## Consequences
Adding cameras and changing recording defaults is admin work; a member who
needs a camera asks an admin. Invite links can't be copied again later
(re-invite instead). Per-instance limits multiply with replicas (ADR 0040). The
console's accept page reads `#invite=` and uses the `/auth/invites` routes; until
it does, the link can be accepted through the API.
