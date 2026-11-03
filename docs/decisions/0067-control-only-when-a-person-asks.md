# 67. Control, only when a person asks

Date: 2026-11-03 · Status: accepted

## Context

Milestone C lets a person switch the devices Senseplane already reads: from
the console, Telegram or the Android app, or by asking their agent. Until
now the bridge was read-only: ADR 0061 said it "never calls a service" and
ADR 0062 that it "never sends a device command". A device that switches is
a different kind of risk from a camera that watches. A plug can power a
heater, a lock opens a home, and an agent can misread a request. The line
in the roadmap stays: Senseplane senses, and switches a device only when a
person asks; it never decides to act on its own.

## Decision

**Only a request can switch a device.** Commands come in through one route,
`POST /v1/devices/{id}/commands`, and its caller is always a principal of
the request: a person signed in (member and up), a workspace key, or an
agent with a Control grant. Nothing else in the API creates `device_control`
work, so watches, workflows, scheduled jobs and the brain can't switch
anything. A test checks that no background code reaches the device routes.
Watch actions stay as they are: they can tell people or systems, never
switch.

**Two switches, both off by default.**
- An admin makes each device **controllable** (`PATCH /v1/devices/{id}`),
  after reading a warning for its type. For a plug it says: "Only make this
  controllable if nothing that could hurt someone is plugged into it or
  wired to it".
- An agent also needs a **`control` grant** on the device's sensor source.
  Like `video` and `audio`, `control` is only ever granted by name: `sensors`
  never covers it. Telegram chats and connected apps get it only when a
  person adds it on the Agents page.

People act within their role. Viewers can't switch, and members and up can.
Making devices controllable is admin work. Workspace keys may switch, as
they may do everything else, but they can't confirm.

**Devices.** A device is an entity a box lists with `controls`, the actions
the box can run on it. It must be chosen (ADR 0061), so its state readings
come back. The API offers an action only if the box can run it and the
device's type allows it. Types are set by Home Assistant's domain and
device class, and for Matter by the sense and device type.

| Tier | Devices | Actions |
|---|---|---|
| Switch: runs at once if allowed | lights, switches and plugs, fans, `input_boolean`, sirens, covers and blinds, climate | on/off, brightness, open/close/position, target temperature (clamped to 10–28 °C) and mode |
| Secure: a person confirms | locks, garage-door and gate covers, `alarm_control_panel` | lock/unlock, open/close, arm away/home, disarm |
| Never: not offered | `water_heater`, vacuums, mowers, valves, and anything whose device class, Matter device type or name says heater, oven, cooktop, medical or machinery | none |

The controllable switch and its warning cover what can't be recognised.

**Secure devices.**
- A person's own request needs `confirm: true`. Without it the answer is
  409 `confirmation_required`, and the console and the app show a dialog.
- A request from an agent or a workspace key waits for a person. The answer
  is 202 `awaiting_confirmation`, and the request shows in the console, in
  the app, and in every linked Telegram chat. Private chats get Confirm and
  Refuse buttons. Groups don't, because anyone in a group could press them.
- Only a person can confirm: a member or above signed in, someone pressing
  the button in a private chat, or the person holding the app. Agents can't
  reach `POST /v1/confirmations/{id}`, a workspace key is refused, and nobody
  can confirm their own request.
- A request nobody confirms within two minutes is refused. A periodic job
  refuses expired requests; it never sends a command.

**The command path.**
1. The API checks the device is controllable, the grant, the action and its
   value, and the rate (10 commands a minute per device). It records the
   attempt in `device_commands` and the audit log.
2. It hands the box a `device_control` command over the existing channel
   (ADR 0062), with `expires_at` ten seconds ahead.
3. The long poll never hands out an expired command. If the box hasn't
   taken the command in time, the API marks it expired and answers 503
   `device_offline`. The box can't run it later, because nothing is queued.
   This process's long polls are woken at once when work is queued.
4. The box runs the command. For Home Assistant it calls a service
   (`call_service`) over the websocket it already holds. For a Matter
   Server it sends `device_command`. With the built-in controller (ADR 0065)
   it uses OnOff, LevelControl, DoorLock (timed), WindowCovering or the
   thermostat setpoint.
5. The box then reads the state back, waiting up to five seconds for it to
   show the goal. It reports `{reached, changed, state, before}`.
6. The API answers with what happened: `done` with the new state,
   `in_progress` (it changed but isn't there yet, such as a door opening),
   `unchanged` ("Sent, but Hall light still reads off"), `failed`, or
   `offline`. It never says done when the state didn't change.
7. A request waits up to 15 s for the box. After that it answers 202 `sent`,
   and the outcome comes later at `GET /v1/device-commands/{id}`.

**The box enforces it too.** The bridge refuses actions an entity doesn't
list, never-tier devices, and setpoints outside 10–28 °C, whatever the API
sends. The bridge's Home Assistant link now calls services, but only for
these commands. This supersedes the "read-only" lines of ADR 0061 and 0062.

**Every attempt is audited.** The log records refused, awaiting, confirmed,
denied, expired, done, in progress, unchanged, failed and offline attempts.
Each entry has who asked and through what (console, app, Telegram, an
agent's name, a workspace key), the device, the action and value, the
outcome, who decided, and the state afterwards. `GET /v1/audit` now returns
each entry's `details`.

**Surfaces.**
- REST: `/v1/devices`, `/v1/devices/{id}/commands`,
  `/v1/device-commands/{id}` and `/v1/confirmations`.
- SDK: `devices` and `confirmations`.
- MCP: two tools, `list_devices` and `control_device`. The tool
  descriptions say to act only on the person's request and to report the
  status as it is.
- Console: a Devices page, the controllable switch, a banner for requests
  to confirm, and Control in the grant editor.
- Telegram: "turn on the hall light", `/devices` with buttons, and confirm
  buttons. It acts as the chat's agent, within its grants.
- Android app: device toggles, a bar of requests to confirm, and a
  notification while the box service runs.

**New senses**, so the state of more devices comes back as readings: `cover`
(open or closed), `alarm` (armed or disarmed) and `setpoint` (°C).

## Consequences

- A compromised box could already switch the devices it reaches, so letting
  it run commands adds no new power. A compromised API key or agent is
  bounded by both switches, the secure tier, the rate limit and the log.
- Name matching for never-tier devices is a heuristic. It errs towards not
  offering a device, and the warning covers the rest.
- Alarm panels that need a code to arm or disarm fail with Home Assistant's
  error; codes aren't handled yet.
- Not yet: scenes, colour, fan speed, and confirming from the Android
  notification itself. Rooms and groups of devices ("turn off everything
  downstairs") are not planned.
