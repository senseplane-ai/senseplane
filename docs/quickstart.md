# Quick start

Give an agent eyes and ears in about ten minutes, on your own machine: run
Senseplane, stream your phone's camera, create a watch, and receive a signed
webhook when it fires.

> **Running Senseplane for real, or just want it up?** Use [Run Senseplane on a
> VM](self-host-vm.md): one file, your domain, HTTPS, `docker compose up -d`.
> This page uses the development stack, for contributors and for trying the API
> step by step.

**You need:** Docker with Compose, Node 24 with pnpm, and `git`. A phone and a
laptop on the same Wi-Fi if you want to use your phone as the camera.

## 1. Run Senseplane

```sh
git clone https://github.com/senseplane-ai/senseplane && cd senseplane
pnpm install
cp .env.example .env
```

Open `.env` and set `AI_BASE_URL` and `AI_API_KEY` for any OpenAI-compatible
endpoint (for example OpenRouter, or a local model server). Senseplane uses it
to compile watches and to check what a camera sees. Without it, detection and
simple watches still work, but nothing is checked by the model.

Start everything (API, media plane, brain, MCP server and their databases):

```sh
docker compose -f deploy/compose/docker-compose.yml --profile app up -d --build
curl http://localhost:58080/healthz      # {"status":"ok"}
```

The first build takes a few minutes. Host ports are offset (5xxxx) so they
don't clash with other local stacks:

| Service | URL |
|---|---|
| API | http://localhost:58080/v1 |
| MCP server | http://localhost:58060/mcp |
| Media signalling | http://localhost:58090 |
| Object storage console (RustFS) | http://localhost:59001 (user `senseplane`, password `senseplane-secret`) |

Create an account, an API key for `curl` and the SDK, and your console
sign-in:

```sh
docker compose -f deploy/compose/docker-compose.yml exec api node dist/cli.js create-account "Me"
# {"account_id":"…","api_key":"sk_…"}
export SENSEPLANE_API_KEY=sk_…   # yours, for the curl examples below
docker compose -f deploy/compose/docker-compose.yml exec -e SENSEPLANE_PASSWORD='a long password' \
  api node dist/cli.js create-user <account_id> you@example.com
```

The key is shown once. Keep it secret: it has full access to the account. It
is for code (the REST API, the SDK, scripts); you never paste it into the
console or into an MCP client's sign-in.

## 2. Start the console and sign in

The console is a web app you run next to the stack:

```sh
pnpm --filter senseplane build
DEV_API_URL=http://localhost:58080 DEV_MEDIA_URL=http://localhost:58090 \
  VITE_MCP_URL=http://localhost:58060/mcp pnpm --filter @senseplane/console dev
```

Open http://localhost:5173 and sign in with the email and password from
`create-user`.

The development stack also lets anyone sign up, so you can use the console the
way a new user would: choose **Create an account** and enter an email and a
password (at least 10 characters). That creates a new workspace with you as its
owner. No email is sent; any address works locally.

To try a team, go to **Settings → Team → Invite someone**, copy the link, and
open it in a private window: the invited person signs up (or signs in) and
joins with the role you chose. Production mode (`SENSEPLANE_MODE=production`)
closes sign-up unless you set `AUTH_SIGNUP=open`; invited people can always
join. See [Self-hosting](self-host.md#sign-in-and-teams).

## 3. Connect a camera

In the console, press **Add phone or laptop camera**.

- **Laptop camera:** open the capture link on the same laptop and allow the
  camera.
- **Phone camera:** phones only allow the camera on HTTPS pages, and the phone
  must reach the media plane on your network. Follow
  [Test with a real phone](dev/phone-testing.md) (about 5 extra minutes), then
  scan the QR code.

Keep the capture page open with the screen on. You'll see the preview and the
**"Senseplane is watching"** indicator. Video is recorded at up to 720p by
default.

You can also create the source from the API. The response contains the
capture link (`ingest.capture_url`, valid for 24 hours):

```sh
curl -s -X POST http://localhost:58080/v1/sources \
  -H "Authorization: Bearer $SENSEPLANE_API_KEY" -H "content-type: application/json" \
  -d '{"name":"Front door","type":"browser","location":"Hallway"}'
```

### An IP camera (RTSP), through the bridge

The bridge is a small container that runs on a computer on the camera's
network. It pulls the camera's RTSP stream and sends it to Senseplane
unchanged, outbound only: no port forwarding.

```sh
curl -s -X POST http://localhost:58080/v1/sources \
  -H "Authorization: Bearer $SENSEPLANE_API_KEY" -H "content-type: application/json" \
  -d '{"name":"Driveway","type":"rtsp"}'
# → {"id":"src_…","type":"rtsp","ingest":{"bridge_token":"brg_…","docker_command":"docker run -d … --token brg_… --rtsp rtsp://USER:PASSWORD@CAMERA-IP:554/stream1"}, …}
```

Run the `docker_command` (shown once) with your camera's RTSP URL in
`--rtsp`. The camera shows `online` within seconds, `reconnecting` (with a
reason) when the bridge loses it. Set the camera's stream to **H.264**: the
bridge never re-encodes. More cameras on the same bridge: create them with
`"bridge_id"` and `"rtsp_url"`, or add more `--rtsp` flags. The bridge image
is `ghcr.io/senseplane-ai/bridge`, built from `bridge/`; see
[bridge/README.md](../bridge/README.md).

### OBS or another WHIP encoder

Create a source with `"type":"whip"`; paste `ingest.whip_url` and
`ingest.token` into OBS (Settings → Stream → Service: WHIP). See
[WHIP ingest](ingest-whip.md).

### Home Assistant sensors

```sh
curl -s -X POST http://localhost:58080/v1/sources \
  -H "Authorization: Bearer $SENSEPLANE_API_KEY" -H "content-type: application/json" \
  -d '{"name":"Server room","type":"sensor","senses":["temperature","humidity"]}'
# → {"id":"src_…","ingest":{"integration_token":"sit_…"}, …}
```

Install the integration from `integrations/home-assistant` (copy
`custom_components/senseplane` into Home Assistant's `custom_components`),
add **Senseplane** under Settings → Devices & services, paste the API URL and
the `sit_…` token, and pick the sensors. Any script can push readings with the
same token:

```sh
curl -s -X POST http://localhost:58080/v1/sources/src_…/readings \
  -H "Authorization: Bearer sit_…" -H "content-type: application/json" \
  -d '{"readings":[{"sense":"temperature","value":24.5,"unit":"celsius","at":"2026-10-16T12:00:00Z"}]}'
```

A watch such as "Warn me if the temperature is above 27 for 5 min" on that
source fires a `reading.threshold` event.

## 4. Receive webhooks

Run a tiny receiver that verifies signatures (save as `hook.mjs`):

```js
// WEBHOOK_SECRET=whsec_… node hook.mjs
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

function verify(body, header, secret) {
  const parts = Object.fromEntries((header ?? "").split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!verify(body, req.headers["senseplane-signature"], process.env.WEBHOOK_SECRET)) {
      console.error("rejected: bad signature");
      return res.writeHead(400).end();
    }
    const event = JSON.parse(body);
    console.log(event.type, event.summary, event.media?.clip_url ?? "");
    res.writeHead(204).end();
  });
}).listen(9999, () => console.log("listening on :9999"));
```

(In TypeScript, the SDK's `verifyWebhook` does the same check.) Now
subscribe. The API runs in Docker, so it reaches your machine at
`host.docker.internal`:

```sh
curl -s -X POST http://localhost:58080/v1/webhooks \
  -H "Authorization: Bearer $SENSEPLANE_API_KEY" -H "content-type: application/json" \
  -d '{"url":"http://host.docker.internal:9999/hook","events":["watch.triggered","detection.person"]}'
# → {"id":"whk_…","secret":"whsec_…",…}
WEBHOOK_SECRET=whsec_… node hook.mjs
```

The `secret` is shown only when the webhook is created. Outside development,
webhook URLs must be public `https` addresses.

## 5. Create a watch

Describe what to look for in one sentence. Senseplane compiles it into a cheap
always-on trigger plus a short check by the vision model:

```sh
curl -s -X POST http://localhost:58080/v1/watches \
  -H "Authorization: Bearer $SENSEPLANE_API_KEY" -H "content-type: application/json" \
  -d '{"instruction":"Tell me when someone is at the front door","sources":["src_…"]}'
```

The response shows the compiled trigger (`compiled.trigger`) so you can check
what will run. Walk in front of the camera: a `detection.person` webhook
arrives within a couple of seconds, and `watch.triggered` once the model has
confirmed it. Each event has a plain-language `summary`, a `confidence`, and
signed snapshot and clip URLs that expire after 15 minutes.

## 6. Connect your agent

Senseplane's MCP server has 10 tools: `list_senses`, `look`, `listen`,
`read_environment`, `watch_for`, `what_happened`, `measure`,
`check_history`, `replay` and `stop_watching`. The quickest local setup, for Claude Code:

```sh
claude mcp add --transport http senseplane http://localhost:58060/mcp
```

Run `/mcp` in Claude Code and connect **senseplane**. Senseplane's consent
page opens in your browser: sign in (an open console tab signs you in by
itself), choose which cameras and sensors Claude Code may use and what it may
do (look, listen, read the environment, set watches, see history), and press
**Allow**. There is no key to copy. Claude Code then shows up under **Agents**
in the console, where you can change its access or disconnect it. For Claude
Desktop, Cursor and other clients, see [MCP setup](mcp-setup.md).

Then ask: *"What's at the front door?"*, *"Tell me if a package is left at
the door"*, *"When did the courier come?"*

## 7. Or use the SDK

The TypeScript SDK lives in `sdk/typescript` (package name `senseplane`). Use
it from inside this repo, or add it to your project from that folder:

```ts
import { Senseplane } from "senseplane";

const sp = new Senseplane({ apiKey: process.env.SENSEPLANE_API_KEY!, baseUrl: "http://localhost:58080/v1" });
for await (const s of sp.sources.list()) console.log(s.id, s.name, s.status);
const watch = await sp.watches.create({ instruction: "Tell me if a package is left at the door", sources: ["src_…"] });
const { data } = await sp.memory.search({ q: "when did the courier come?" });
```

## Next

- [API guide](api/README.md): authentication, errors, pagination, events and webhooks.
- [Self-hosting](self-host.md): running Senseplane for real.
- [Lawful camera use](lawful-use.md): read this before pointing a camera at anyone.

## Troubleshooting

- **`watches` returns `503 service_unavailable` "the brain did not answer":**
  the brain container isn't running yet, or can't reach Valkey.
  Check `docker compose -f deploy/compose/docker-compose.yml logs brain`.
- **The capture page is stuck on "Connecting…":** the browser can't reach
  the media plane's WebRTC port (40000 TCP/UDP). See
  [Test with a real phone](dev/phone-testing.md).
- **`source_limit_reached`:** `QUOTA_MAX_SOURCES` is set in your
  environment. Leave it empty for no limit.
- **A bridge camera stays `reconnecting`:** `status_detail` says why. "no
  H.264 video" means the camera streams H.265 or MJPEG; switch it to H.264.
  A connection error means the bridge's computer can't reach the camera's RTSP
  URL. `docker logs senseplane-bridge` shows the same, without passwords.
