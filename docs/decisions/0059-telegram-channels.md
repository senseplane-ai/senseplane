# 59. Telegram chats as channels: alerts and questions

Date: 2026-10-19 · Status: accepted

## Context

Watches could send their events to webhooks and to agents' inboxes (ADR
0043), both for code. Nothing reached a person's phone. People looking after
someone, or a home or a shop, want the alert where they already are, and want
to ask "has she eaten?" from there too.

## Decision

**Channels.** A channel is a chat in a messaging app linked to a workspace,
Telegram first (`channels`, kind `telegram`). A watch sends to it when its
`notify` lists `{type: "channel", id}`; nothing else changes about routing.
Other apps (email, Slack, Discord, WhatsApp, ntfy) are further kinds of
channel.

**One bot per server.** A server uses its own bot (`TELEGRAM_BOT_TOKEN`, from
@BotFather), whatever number of workspaces it has: each chat has its own id,
and the `channels` table says which workspace it belongs to.

**Linking.** An admin makes a one-time code (`POST /v1/channels/telegram/link`,
10 minutes, stored hashed). Opening `t.me/<bot>?start=<code>`, or
`?startgroup=` for a group, sends `/start <code>` to the bot, which redeems the
code and links that chat. Nobody can link a chat to a workspace without a
code from it. A chat can be linked to several workspaces; `/use` chooses
which one answers.

**Questions as an agent.** Linking creates an agent of kind `channel` with a
grant on the workspace's cameras at that time and their senses, with the
`history` ability and without `watch`, and a key stored encrypted. A question
from the chat is sent through the API's own conversation routes with that key
(`inject`), so grants, the AI-check allowance, the audit log and revocation
apply exactly as for any agent. Removing the agent on the Agents page unlinks
the chat. In a group, questions are `/ask …` or a reply to the bot (what
Telegram's privacy mode lets a bot see). Each chat may ask 30 questions an
hour.

**Outbox.** Everything sent (alerts, answers, notices) is a row in
`channel_messages`, claimed like a webhook delivery (ADR 0058). At most one
message per chat is in flight, and each chat waits 1 s (private) or 3 s
(group) between messages, Telegram's limits. A 429 waits for Telegram's
`retry_after`; a 403 (blocked, removed) marks the channel blocked and stops;
other errors back off for an hour. An alert is a photo of the snapshot with
the camera, time and summary as its caption (text only when the chat turns
snapshots off), and buttons to the recording in the console and to mute for
an hour.

**Updates.** In polling mode (the default) a background job long-polls
`getUpdates`, one process at a time, keeping the offset as the job's state; no
public URL is needed. In webhook mode Telegram posts to `/telegram/webhook`,
checked against `TELEGRAM_WEBHOOK_SECRET`, and an hourly job keeps the
webhook set. Either way each update is stored once by its id
(`telegram_updates`) and handled by whichever process claims it, so a
redelivered update isn't handled twice.

## Consequences

- People get alerts and answers where they already are, with no app to
  install, from a server that may have no public address.
- Snapshots go to Telegram's servers. Each chat can turn them off, and the
  docs and lawful-use guide say so; recordings stay behind a sign-in.
- Anyone in a linked group can ask. That is the point of a family group, and a
  reason to think before linking one.
- A chat's grant is fixed when it is linked: cameras added later aren't
  included until its access is edited on the Agents page.
