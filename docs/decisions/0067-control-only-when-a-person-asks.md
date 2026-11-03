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

**Things that open a home are secure, whatever they are wired as.** A
Home Assistant cover with device class `door`, and any switch,
`input_boolean` or cover (Matter's too) whose name or entity id says
garage, gate, door or lock, is promoted to the secure tier: a Shelly relay
on a garage motor, or a Matter blind that is really a gate. Promotion never
demotes anything, and it doesn't apply to lights or fans. The warnings for
switches and covers ask people to name door and gate openers so.

**Secure devices.**
- A person's own request needs `confirm: true`. Without it the answer is
  409 `confirmation_required`, and the console and the app show a dialog.
- A request from an agent or a workspace key waits for a person. The answer
  is 202 `awaiting_confirmation`, and the request shows in the console and
  in the app.
- **Telegram.** Confirm buttons go only to private chats that were linked by
  someone who is still a member or above, and whose chat agent can see the
  device's source. Both are checked again when the button is pressed.
  Groups, and chats linked with a workspace key or by someone who left or
  became a viewer, never get buttons. A person asking in their own
  qualifying chat ("unlock the front door") makes their own request: the
  buttons in that chat are their "are you sure", like `confirm: true`, and
  it is recorded as their request, confirmed by them.
- Only a person can confirm: a member or above signed in, or the person
  whose qualifying private chat it is. Agents can't reach
  `POST /v1/confirmations/{id}`, a workspace key is refused, and an agent's
  or a key's request can't be confirmed by the same agent or key.
- A request runs once. Only the answer that moves it from waiting runs it;
  a second tap, a refusal after an approval, or a late approval is answered
  409 and changes nothing.
- On approval the API checks again that the requesting agent isn't revoked
  and still has a Control grant covering the device, or that the key isn't
  revoked. If not, the request is refused and audited.
- A request nobody confirms within two minutes is refused. A periodic job
  refuses expired requests; it never sends a command.

**The command path.**
1. The API checks the device is controllable, the grant, the action and its
   value, and the rate (10 commands a minute per device, counted and
   recorded under a lock on the device's row, so concurrent requests can't
   all slip under it). It records the attempt in `device_commands` and the
   audit log.
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
7. The command carries a `run_by` deadline: the take deadline plus five
   seconds. The box compares it with the API's clock (from the long poll's
   `Date` header), allowing five seconds more, and refuses a command that
   arrives later, so a slow network can't run it late. A command the box
   took and never reported is given up after a minute: it reads failed ("it
   may or may not have run"), and the box's late report is refused.
8. A request waits up to 15 s for the box. After that it answers 202 `sent`,
   and the outcome comes later at `GET /v1/device-commands/{id}`.

**The box enforces it too.** The bridge refuses actions an entity doesn't
list, never-tier devices, and setpoints outside 10–28 °C, whatever the API
sends. If Home Assistant doesn't say which temperature unit it uses, the box
refuses to set a thermostat rather than assume Celsius. A setting sent in °F
is rounded towards the safe side, so 28 °C never becomes more than 28 °C. The bridge's Home Assistant link now calls services, but only for
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
(open or closed), `alarm` (armed or disarmed) and `setpoint` (°C). `control`
and `sensors` are grant words, never readings or a source's senses. A
Telegram chat's first grant never includes `audio` or `control`: a person
grants listening and switching on the Agents page.

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
