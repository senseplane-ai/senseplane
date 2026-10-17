# @senseplane/console

The web console: cameras, playback, watches, Ask, agents and settings, plus the
phone capture page.
React 19 and Vite with a small in-repo router and UI kit (ADR 0046). It calls
only the public `/v1` and `/auth` APIs.

- `pnpm dev` runs it on Vite and proxies `/api` to `DEV_API_URL`
  (default `http://localhost:8080`) and `/media` to `DEV_MEDIA_URL`.
- `pnpm test` runs the Vitest and Testing Library tests.
- `pnpm e2e` runs the Playwright end-to-end with an in-page fake API and saves
  screenshots to `e2e/screenshots/`. Set `E2E_LIVE=1` and `DEV_API_URL` to run
  it against a compose stack started with `AUTH_SIGNUP=open`.

Layout: `src/styles` (tokens, fonts, base), `src/ui` (shared components),
`src/shell` (sidebar, session data), `src/pages` (screens; admin pages under
`src/pages/admin`), `src/capture` (the phone capture page).
