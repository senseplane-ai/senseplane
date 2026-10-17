# 46. Console architecture

Date: 2026-10-16 · Status: accepted

## Context
The console was a single page with tabs, written for the M1 to M6 checks. The
approved design has an app shell with a sidebar, a chat-first home (Ask),
camera pages with recorded playback, a live view and a guided "Add a camera"
flow. Several backend features it shows (conversations, live view, `/v1/me`,
account limits) are being built at the same time, so the console must work
before and after they land. Admin pages (events, watches, search, agents,
webhooks, usage, settings) are built separately and mounted by the shell.

## Decision
- **Stack:** React 19 and Vite, no UI framework. Plain CSS with design tokens
  as custom properties in `console/src/styles/tokens.css`; the variable names
  are shared with the admin pages. The console is dark only.
- **Fonts:** Geist and Geist Mono (SIL OFL 1.1) are self-hosted from the
  `@fontsource` packages, so the console makes no third-party font requests.
- **Routing:** a ~90-line History API router (`console/src/router.tsx`):
  `useLocation`, `navigate`, `matchPath` and `Link` (plain clicks navigate in
  the app; modified clicks open new tabs). Paths are real URLs
  (`/cameras/src_…`, `/chats/cnv_…`); the Vite dev server, `vite preview` and
  any static host with an `index.html` fallback serve deep links.
  `capture.html` and `play.html` stay separate entry points.
- **Routes:** `/` and `/chats/:id` (Ask), `/cameras`, `/cameras/new` (no
  shell), `/cameras/:id`, `/live`, and the admin pages at `/events`,
  `/watches`, `/search`, `/agents`, `/webhooks`, `/usage`, `/settings` from
  `console/src/pages/admin/index.ts`, each given `{client, apiUrl, apiKey,
  navigate}`.
- **Session:** unchanged from ADR 0031: an expiring API key in
  `sessionStorage`, OAuth hands it back in the URL fragment. Sign-in keeps the
  current path, so a deep link opens after signing in. Any `401` from the API
  ends the session and returns to sign-in with "Your session ended". A pasted
  API key is checked against `/v1/account` first.
- **Sign in:** Google and GitHub show only when `/auth/providers` says so;
  sign-up shows when sign-up is open. "Forgot password?" shows only if the
  providers response has `password_reset: true`, since the open-source API has
  no reset route yet. New passwords need at least 10 characters (the API
  minimum).
- **Shared state:** `AppDataProvider` loads sources (every 10 s), the account
  with `limits`, `/v1/me`, recent conversations and an unread events count
  (every 30 s; events since the last visit to `/events`, stored per browser).
- **Endpoints the SDK lacks** go through `console/src/api/extra.ts`, a small
  typed fetch helper. `isUnavailable(e)` (404, 405, 501, `not_implemented`)
  lets a page show a clear empty state while a backend is missing:
  - no conversations API: the sidebar hides Recent chats and Ask explains
    that chat isn't available yet;
  - no `/v1/me`: the user block shows the account name;
  - no `limits` on the account: the self-host defaults (live view on,
    everything else unlimited).
- **Chat streaming:** answers stream with `fetch` and a small SSE parser
  (`api/sse.ts`), because `EventSource` can't POST or send an Authorization
  header. If the server replies with JSON instead, it is used as the final
  message.
- **UI kit:** `console/src/ui` holds the shared, accessible primitives
  (buttons are real buttons, links are links, tabs follow the WAI-ARIA
  pattern, switches use `role="switch"`, dialogs use the native `<dialog>`,
  toasts use a polite live region, tables scroll sideways in a focusable
  region). The admin pages keep their own small kit for now.
- **Responsive:** under 860 px the sidebar folds into a top bar with a menu
  button; pages stack to one column and never scroll sideways at 390 px.
- **Live view** uses `openLive` from `console/src/live/client.ts`. Tiles fall
  back to the latest snapshot from `/now` (every 10 s) when a live stream
  can't open; the LIVE badge shows only on a real stream. Live view is locked
  when `limits.live_view === false` or a stream is refused with
  `feature_not_available`; the locked panel names no plan unless the server
  sends `plan_label`. `limit_reached` shows a short toast.
- **Tests:** Vitest with Testing Library and jsdom for components, and a
  Playwright end-to-end (`pnpm --filter @senseplane/console e2e`). It runs
  against an in-page fake API by default and against a compose stack with
  `E2E_LIVE=1`. It saves screenshots at 1440 and 390 px to
  `console/e2e/screenshots/` (git-ignored).

## Other choices
- A hand-rolled router instead of a dependency: the console has a dozen flat
  routes.
- Camera status words: `online` reads "Streaming" ("Reporting" for sensors),
  `offline` reads "Offline" and counts as "Needs attention", `pending` reads
  "Waiting to connect". "Paused" appears only if a source reports `paused`.
- **Pause** calls `POST /v1/sources/{id}/pause` (`/resume`). Until the API has
  it, the console says pausing isn't available yet.
- **Feedback buttons** on answers only mark the answer in this browser; there
  is no message feedback endpoint yet. Copy copies the answer text.
- **Right now** on the camera page shows the latest snapshot (and readings)
  and never spends an AI check; only "Ask this camera" does.
- **Recorded playback** loads a signed range of up to an hour from the chosen
  time. The shown position is the range start plus the video's current time,
  so it is approximate across gaps. A scrub into a gap jumps to the next
  recording. Save clip keeps 15 s either side of the position.
- **Moment cards and Rewind 1 minute** open `/cameras/:id?t=<ISO time>`.
- **Detections in live view** show the latest detection label (from the
  last minute's `detection.*` events), not boxes: events carry no positions.
- **Add a camera:** "IP camera" creates `type: "rtsp"` and shows the bridge
  command from `ingest`; a server without it gets a clear message. Home
  Assistant creates a sensor with `senses`, retrying without them on servers
  that don't accept the field, and shows the integration token, or the sensor
  ID when the server has none. The source is created when leaving step 2; Back
  then edits it instead of creating another.
- **Ask scope:** the camera picker sends `sources: [id]`; the time picker
  sends `from`/`to` for Today, Last hour, Last 24 hours, Yesterday or Last 7
  days, or no window for Any time.

## Consequences
- The console works on today's API and lights up as conversations, live view,
  `/v1/me` and limits land, without code changes.
- Two small UI kits exist until the admin pages move onto `console/src/ui`.
- The fake API in `console/e2e/fake-api.ts` must follow contract changes, or
  the default e2e drifts from the real API; `E2E_LIVE=1` catches that.

## Addendum (2026-10-16, integration)

- **Pause** and **feedback** are wired to their endpoints (ADR 0045, 0041).
- **Invite links** (`#invite=<token>`, ADR 0044): the token is read once and
  cleared from the address bar, kept for the tab, and the accept page shows the
  workspace and role, then joins with the current session, the invited
  address's password, a new account, or Google/GitHub (`?invite=` on the OAuth
  start).
- Cameras that dropped show "No video since hh:mm" from `status_since`
  (ADR 0045); `reconnecting` reads "Reconnecting".
- The camera page follows a new `?t=` while open (a search result for the same
  camera).
- The old single-page screens are gone; the end-to-end journey (`pnpm e2e`,
  `e2e/journey.ts`) drives the real console against a real stack.
