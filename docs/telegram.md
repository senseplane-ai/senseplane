# Telegram: alerts and questions

Link a Telegram chat and Senseplane sends it the alerts of the watches you
choose, with a snapshot and a button to the recording. People in the chat can
also ask about the cameras, the same way as the chat in the console: "How many
times did someone come to the door today?", "Has Mum had lunch?", "Is it
quieter than usual?" ([ADR 0059](decisions/0059-telegram-channels.md)).

## Set up the bot (once per server)

1. In Telegram, message **@BotFather** and send `/newbot`. Give it a name and
   a username ending in `bot`, such as `MumsFlatBot`.
2. Copy the token it gives you into the settings block of
   `docker-compose.yml`:

   ```yaml
   TELEGRAM_BOT_TOKEN: "123456789:AA…"
   ```

3. Run `docker compose up -d`.

Senseplane asks Telegram for new messages itself (long polling), so it works
behind a home router: no public URL, open port or webhook is needed. The token
is a secret; keep `docker-compose.yml` readable only by you (`chmod 600`).

## Link a chat

In the console, open **Settings → Notifications → Connect Telegram**.

- **Open @YourBot** opens a private chat with the bot. Press **Start**.
- **Add to a group** lets you choose a group (a family group, say). Telegram
  adds the bot and sends it the link.

The link works once, for 10 minutes, and only an owner or admin can make one.
The page shows the chat as soon as it is linked.

Then, when you make or edit a watch, choose the chat under **Send to**.

## Alerts

Each alert is the snapshot with the camera, the time and what happened, plus
two buttons:

- **View recording** opens the camera's recording at that moment in the
  console (after signing in). It appears when the console has a public `https`
  address, which Telegram requires for buttons.
- **Mute for 1 hour.**

Summaries (digest watches, such as "a summary of Mum's day at 20:00") arrive
as text.

In the chat:

| Command | What it does |
|---|---|
| `/mute 1h`, `8h`, `1d`, `1w` | Pause alerts here. `/mute off` turns them back on |
| `/new` | Start a new conversation (questions otherwise follow on for 30 minutes) |
| `/use <workspace>` | Choose which workspace answers, when the chat is linked to more than one |
| `/devices` | The devices this chat may switch, with buttons (see [Devices](#devices)) |
| `/stop` | Unlink the chat |
| `/help` | The list |

## Questions

In a private chat, send any message. In a group, start with `/ask`, or reply
to one of the bot's messages; Telegram doesn't show bots other messages in a
group.

Answers are worked out exactly as in the console chat, and cite the moments
they use as buttons. A chat asks as an **agent** of its own, so:

- It can see the cameras the workspace had when it was linked, and their
  sensors, but not hear their sound or switch devices: a person gives those
  on the **Agents** page, where the chat is listed with the connected apps.
- It can ask questions, but not set watches.
- Each chat can ask up to 30 questions an hour. Answers use AI checks like any
  other question, and stop with a message when the workspace has used its
  allowance.

Turn questions off for a chat with its **Questions** switch in Settings →
Notifications.

## Devices

A chat can switch the devices Senseplane reaches through a box, when a
person asks (ADR 0067). Say what you want in plain words, such as "turn on
the hall light", "set the bedroom thermostat to 20", "close the blinds" or
"unlock the front door". In a group, start with `/ask`. `/devices` lists
the devices this chat may switch, each with buttons.

The chat acts as its agent, so it needs two things, both off by default:

- An admin makes the device **controllable** on the **Devices** page.
- The chat's agent gets the **Control devices** permission on the device's
  room, on the **Agents** page. "Read sensors" doesn't include it.

The answer says what the box read back afterwards. "Sent, but Hall light
still reads off" means the device didn't change.

**Locks, garage doors, gates and alarms** wait for a person to confirm. So
does a switch or a blind named for a garage door, gate, door or lock.

- When you ask in your own private chat, the chat asks "Are you sure?" with
  **Confirm** and **Refuse** buttons. It is your request, confirmed by you.
- When an agent asks, the buttons go to the private chats of people who are
  members or above in the workspace and whose chat can see the device.
- Groups, and chats linked by someone who is no longer a member, never get
  buttons: confirm those requests in the console or the app.

Who may press is checked again when the button is pressed, and a request runs
once, however many times it is confirmed. A request nobody confirms within
two minutes is refused. Every request, and what happened to it, is in the
audit log.

## Privacy

- **Snapshots sent to Telegram are stored by Telegram**, on its servers, under
  its terms. Turn **Snapshots** off for a chat to send text only. Recordings
  stay on your server and need a sign-in.
- **Everyone in a group** sees its alerts and can ask about the cameras. Link
  a group only if everyone in it should.
- A chat that blocks the bot or removes it from a group stops getting alerts.
  Linking it again starts afresh.

## Larger deployments

A server with several API processes can let Telegram post updates to it
instead of polling:

```sh
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_SECRET=<16–256 letters, digits, _ or ->
API_PUBLIC_URL=https://senseplane.example.com   # Telegram posts to $API_PUBLIC_URL/telegram/webhook
```

Updates are stored once and handled by one process, and messages to each chat
are spaced to Telegram's limits, whichever process sends them
([ADR 0058](decisions/0058-background-work-in-postgres.md)).
