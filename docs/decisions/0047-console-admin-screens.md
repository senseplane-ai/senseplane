# 47. Console admin screens

Date: 2026-10-16 · Status: accepted

## Context
The console gets its designed screens. The admin half (Events, Watches,
Search history and saved clips, Agents and keys, Webhooks, Usage, Settings)
is built at the same time as the console shell and as the backends for watch
destinations, team, live view limits and workspace settings. It has to work
against today's API and pick up those endpoints as they land.

## Decision
- **Layout.** Everything lives in `console/src/pages/admin/`. `index.ts`
  exports one component per screen, each taking
  `{ client, apiUrl, apiKey, navigate }`. The shell owns routing and the
  sidebar; the screens render only their content. They use the shared token
  names (`--bg`, `--panel`, `--live`, …) through `admin.css`, where every
  class starts with `adm-`, and their own primitives in `kit.tsx` (chips,
  switch, tabs, menu, dialog, copy button, HLS video). They do not import the
  console-wide UI kit; the two are deduplicated after both land.
- **API access.** Existing endpoints go through the SDK. Endpoints the SDK
  does not have yet (watch `notify`, `active_hours` and `/watches/test`,
  `/me`, `/members`, `/invites`, workspace `time_zone`, account `limits` and
  `plan_label`, webhook edit, secret rotation and test sends) go through a
  small typed helper, `api.ts`, written against the build contracts. When a
  server answers 404 "route not found" (or 501/405) the screen says the
  feature "isn't available on this server yet" and keeps working.
- **Roles.** `/v1/me` gives the role. Without it the key is treated as the
  owner's (single-user servers). Viewers can't change anything; members can
  manage watches and clips; owners and admins manage keys, webhooks, team and
  settings; only the owner sees "Delete workspace". The API stays the
  authority; the console only disables what would be refused.
- **Events.** Filters: kind (watch fired, detections, alerts, by event type),
  camera, and time range (today, 7 or 30 days, custom). New events arrive by
  polling the first page every 10 s while the page is visible; "Load older"
  follows the cursor. Selecting an event fetches it again for fresh signed
  URLs. "Sent to" is the watch's `notify` list, or (for older watches and
  other events) every webhook subscribed to the type.
- **Watches.** There is no compile-preview endpoint, so "How Senseplane will
  watch" shows a draft built from the form, then the compiled steps once the
  watch is created. Active hours presets map to `active_hours` with the
  workspace time zone (or the browser's). Last fired and counts come from the
  past week's `watch.triggered` events. Edit sends `instruction`, `sources`,
  `notify` and `active_hours` in one PATCH.
- **Agents and keys.** An API key here is an agent key: "Create key" creates
  an agent and one grant (cameras, look/listen/sensors, optional window) and
  shows the key once. "Edit access" replaces the agent's grants with one new
  grant. Owner keys are not listed by the API; a fixed row warns that they
  have full access. The MCP address comes from `VITE_MCP_URL`, otherwise
  `/mcp` next to the API; no fixed domain is written into the console.
- **Clips.** "Download" fetches the clip's signed HLS playlist and joins the
  init segment and fMP4 fragments into one MP4 in the browser; no new
  endpoint is needed.
- **Usage.** Meters read `GET /v1/usage` against `limits` from
  `GET /v1/account`; a null limit shows "unlimited" and hides the bar. The
  plan card appears only when the deployment sends `plan_label`. The daily
  chart has a text summary for screen readers plus a hidden data table.
- **Settings.** Sign-in methods are read-only from `GET /auth/providers`. The
  workspace-wide "record audio" default is shown read-only unless the account
  returns `record_audio_default`. Maximum resolution is read from the sources.

## Consequences
Screens can merge before the backends they use; each lights up when its
endpoint ships. Some numbers are estimates until the API returns them
directly (agents' last use, per-camera storage and AI checks, delivery
timings show "—"). The old single-file screens go when `App.tsx` switches
to these.

## Addendum (2026-10-16, integration)

The old single-file screens and the dev harness (`admin-harness.html`) are
removed; the screens run in the console shell, and `e2e/journey.ts` covers
them with the real API. A watch with no destinations reads "Subscribed
webhooks" (ADR 0043: empty `notify` keeps the old routing), not "Events only".
The admin primitives in `kit.tsx` stay for now: they differ from
`console/src/ui` in props and markup enough that swapping them is a redesign
of each screen, not a straight swap.

## Addendum (2026-10-17): Agents leads with connected apps (ADR 0048)

The Agents page (nav label "Agents") lists the apps connected through MCP
consent first: when each connected and was last active, its redirect host,
what it can use, **Edit access** in place with the consent page's picker, and
**Disconnect**. With no apps it shows how to connect one, with the MCP URL to
copy and per-client steps. API keys for scripts and custom code are in a "For
developers" section (Create API key, shown once; same picker plus an optional
time window). The MCP address comes from `VITE_MCP_URL`, else `mcp_url` from
`/auth/providers`, else `/mcp` next to the API.
