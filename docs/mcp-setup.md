# Connect an agent with MCP

Senseplane's MCP server gives an agent 8 tools: `list_senses`, `look`,
`listen`, `read_environment`, `watch_for`, `what_happened`, `replay` and
`stop_watching`. See [MCP tools](api/mcp-tools.md) for their inputs and
outputs.

There are two ways to run it:

| | Local (stdio) | Remote (Streamable HTTP + OAuth) |
|---|---|---|
| Runs | as a process your MCP client starts | as the `mcp` service, at `/mcp` |
| Auth | an API key in an environment variable | you press Connect in the client, sign in on Senseplane's consent page and choose what it may use; or an `Authorization: Bearer sk_…` header |
| Good for | Claude Desktop, Cursor, Claude Code on the same machine | Claude Code, Cursor, any client that supports remote servers; claude.ai once the URL is public |

Either way the agent only sees what it was given. A remote client gets the
cameras, sensors and permissions you pick on the consent page. For the local
server, create an API key in the console under **Agents → For developers →
Create API key** (or `POST /v1/agents` and `POST /v1/grants`, see the
[API guide](api/README.md#agents-and-grants)).

## Before you start

You need a running Senseplane (see the [quick start](quickstart.md)) and a
console sign-in as an admin or owner of the workspace. For the local server
you also need an API key (`sk_…`), and to build it once:

```sh
pnpm install
pnpm --filter senseplane build && pnpm --filter @senseplane/mcp build
```

The stdio server is then at `mcp/dist/stdio.js`. Below, replace
`/path/to/senseplane` with your clone's path, and `58080` with your API port
if you changed it.

## Claude Desktop

**Local (stdio):** edit `claude_desktop_config.json` (Settings → Developer →
Edit Config) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "senseplane": {
      "command": "node",
      "args": ["/path/to/senseplane/mcp/dist/stdio.js"],
      "env": {
        "SENSEPLANE_API_KEY": "sk_…",
        "SENSEPLANE_API_URL": "http://localhost:58080/v1"
      }
    }
  }
}
```

**Remote:** add a custom connector with your server's `https://…/mcp` URL.
Claude's remote connectors connect from the internet, so the MCP server must
be publicly reachable over HTTPS (see [Remote server on a public
URL](#remote-server-on-a-public-url)).

## Claude Code

**Remote (recommended locally):** with the stack running,

```sh
claude mcp add --transport http senseplane http://localhost:58060/mcp
```

Run `/mcp` in Claude Code and choose **senseplane** to connect. Senseplane's
consent page opens in your browser (see [Connecting a remote
client](#connecting-a-remote-client)); press **Allow** and Claude Code is
connected. It appears under **Agents** in the console as "Claude Code".

**Local (stdio):**

```sh
claude mcp add senseplane \
  -e SENSEPLANE_API_KEY=sk_… \
  -e SENSEPLANE_API_URL=http://localhost:58080/v1 \
  -- node /path/to/senseplane/mcp/dist/stdio.js
```

## claude.ai (remote connector)

In claude.ai, open Settings → Connectors → **Add custom connector** and enter
your server's public `https://…/mcp` URL. Claude opens Senseplane's consent
page; sign in, choose what Claude may use and press **Allow**. `localhost` URLs
don't work here, because claude.ai connects from the internet. The one-file
self-host ([VM guide](self-host-vm.md)) shows claude.ai as verified on the
consent page; elsewhere, add `claude.ai` to `MCP_TRUSTED_REDIRECT_HOSTS`.

## Cursor

Edit `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project).

**Local (stdio):**

```json
{
  "mcpServers": {
    "senseplane": {
      "command": "node",
      "args": ["/path/to/senseplane/mcp/dist/stdio.js"],
      "env": {
        "SENSEPLANE_API_KEY": "sk_…",
        "SENSEPLANE_API_URL": "http://localhost:58080/v1"
      }
    }
  }
}
```

**Remote:**

```json
{
  "mcpServers": {
    "senseplane": { "url": "http://localhost:58060/mcp" }
  }
}
```

Cursor shows a **Connect** (or **Login**) button for the server; it opens the
consent page.

## Any other MCP client

- **stdio:** run `node /path/to/senseplane/mcp/dist/stdio.js` with
  `SENSEPLANE_API_KEY` and `SENSEPLANE_API_URL` in the environment.
- **Streamable HTTP:** point the client at `http(s)://<host>:<port>/mcp`. The
  server publishes OAuth metadata at `/.well-known/oauth-protected-resource`
  and `/.well-known/oauth-authorization-server` (authorization code flow with
  PKCE `S256`, dynamic client registration at `/oauth/register`).
- **Header auth:** clients and scripts that send custom headers can skip OAuth
  with `Authorization: Bearer sk_…` (an API key from **Agents → For
  developers**).

Quick check with `curl`:

```sh
curl -s -X POST http://localhost:58060/mcp \
  -H "Authorization: Bearer $SENSEPLANE_API_KEY" \
  -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Connecting a remote client

What happens when you press Connect (ADR 0048):

1. The client registers with the MCP server and opens its `/oauth/authorize`
   in your browser. The MCP server checks the request (registered redirect
   URI, PKCE `S256`) and sends you on to the console at `/connect`.
2. The consent page says which app is asking ("Claude Code wants to use your
   cameras") and where access is sent. A redirect host that isn't in
   `MCP_TRUSTED_REDIRECT_HOSTS` is marked **not verified**: the name is chosen
   by the app itself, so only continue if you started the connection.
3. Sign in with your usual console account (email and password, or Google or
   GitHub when configured). If the console is open in another tab of the same
   browser, that session is used and you skip this step.
4. Pick the cameras and sensors, and what the app may do: **Look** (live
   pictures and questions about them), **Listen** (sound events, never
   speech), **Read environment** (temperature and humidity), **Set watches**,
   and **See history and replay** (events, search and recordings older than
   two hours). Listen is off unless you turn it on.
5. Press **Allow**. Senseplane creates an agent named after the app with that
   access and a key of its own, which stays between the API and the MCP server.
   The client receives OAuth tokens tied to that agent. **Cancel** tells the
   client you declined.

**Who can connect apps:** admins and owners of the workspace. Members and
viewers see who to ask.

**Reconnecting** the same app (same name, same redirect host; the port of a
local client doesn't matter) reuses its agent and replaces its access with
what you pick; there is never a second "Claude Code". Each machine that
connects keeps its own key, up to five per app (the oldest is retired first).

**Changing or ending access:** in the console under **Agents**, each connected
app shows when it connected, when it was last active and what it can use.
**Edit access** changes it in place (effective on the app's next request);
**Disconnect** revokes the app's keys, so its tokens stop working at once and
refreshing them fails.

## Remote server on a public URL

To use the remote server from outside your machine:

1. Put the `mcp` service behind a reverse proxy with TLS (see
   [Self-hosting](self-host.md#tls-and-a-reverse-proxy)).
2. Set `MCP_PUBLIC_URL` to the public base URL (for example
   `https://mcp.example.com`) and `SENSEPLANE_PUBLIC_API_URL` to the public API
   URL. OAuth redirects and metadata use these, so they must match what
   clients see. Set the same `MCP_PUBLIC_URL` on the API, so the console shows
   it, and `MCP_CONSOLE_URL` on the MCP server to the console's public URL
   (where the consent page lives).
3. Set `MCP_TOKEN_SECRET` to a long random value. In production mode the
   server refuses to start with the development default.
4. Set `TRUST_PROXY=1` if the proxy sets `X-Forwarded-*` headers.

## Watch destinations and the inbox

A watch's `notify` list says where its `watch.triggered` events go: some of
the account's webhooks, some agents, or both (ADR 0043). Events for an agent
wait in that agent's inbox until it reads them. Three ways to get them:

1. **`what_happened`** (every client): new inbox events come first, as
   `new_from_your_watches` (camera name, time, summary, signed snapshot and
   clip links), and are then marked seen.
2. **Notifications** (clients that keep a session open): while connected, the
   server checks the inbox every `MCP_INBOX_POLL_SECONDS` (default 10) and,
   for new items, sends
   - a logging message, `notifications/message` with `logger:
     "senseplane.inbox"`, level `notice`, and `data: {message, events}`;
   - `notifications/resources/updated` for `senseplane://inbox` (over stdio
     after `resources/subscribe`; on the remote server the open stream is the
     subscription).

   Over stdio this works as soon as the client has initialised. On the remote
   server (`/mcp`), the client opens the optional GET stream
   (`Accept: text/event-stream`, same bearer token); the official MCP SDKs do
   this by themselves. Many chat clients show these notifications but don't
   wake the model, so `what_happened` is still the reliable path.
3. **The resource** `senseplane://inbox`: `resources/read` returns the unread
   events without marking them seen.

From code, the same inbox is `GET /v1/inbox?unseen=true` and
`POST /v1/inbox/seen` (an agent key reads its own; an account key passes
`agent`).

## Things to know

- **Your agent's watches report to its inbox.** With an agent key,
  `watch_for` routes the watch's events to that agent (`notify:
  [{type: "agent", id}]`, see [Watch destinations](#watch-destinations-and-the-inbox)).
  The next `what_happened` returns them first, under `new_from_your_watches`,
  and marks them seen. Pass `notify_me: false` to send them to the account's
  webhooks instead.
- **`look` returns the image itself** as an image content block (plus a signed
  URL), so the model can see the frame.
- **`listen` never transcribes speech.** It reports sound classes such as
  crying, barking, glass breaking and alarms.
- **Grants apply.** An app or key without Listen (the `audio` sense) gets
  `forbidden_sense` on `listen`; without Set watches, `watch_for` is refused;
  without See history and replay, `what_happened` and `replay` only reach the
  last two hours.
