# Media contract conformance suite

A black-box check that a media plane implements [`spec/media`](../spec/media)
the way Senseplane relies on it. It talks to the media plane only over the
network: the control API, signalling, WHIP, and the callbacks the media plane
sends. It is Apache-2.0 and part of this repository; another implementation
runs it as an external tool, nothing is vendored (ADR 0053).

| Group | What it checks |
|---|---|
| `tokens` | Join, control and WHIP tokens accepted and refused like the golden vectors (`spec/media/vectors/tokens.json`): every claim rule, unknown kid, bad signature, single use, protocol version |
| `control` | healthz, usage, rooms (idempotent, `signal_url`, options, get, delete), participant removal with a reason and the removal-time gate, room events with the room's bearer, egress refusals |
| `signalling` | A Chrome publisher (H.264 + Opus) and viewers: `subscribeKinds` on `joined`, `producerAppeared` and `consume`, decoded frames, newest-replaces (`roomClosed: replaced`, 1008), the RTMP-style `duplicate_identity` refusal |
| `whip` | OPTIONS, PATCH 405, 415 before authorize, bearer audience, `authorize_url` asked with the bearer, a real Chrome WHIP publish that connects, the participant in the room, DELETE needs the bearer |
| `feed` | A `segments` + `frames` egress against a mock callback that is also the bucket: init first, ~6 s segments with the key layout, stored bytes, feed events and idempotency keys, frames batches (≤ 5 JPEGs at 640x360, 1 s of 16 kHz audio), offline, a new run with a gap and its own init, stop and `egress.session.ended`, and the resolution refusal storing nothing |

It needs Node 24, Chrome (`CHROME_PATH`, found automatically on macOS and in
the usual Linux places) and network reach both ways.

## Against the open-source media server

```sh
pnpm install
pnpm --filter @senseplane/media build
node conformance/src/oss.ts          # starts media/dist on free ports, runs everything, stops it
```

CI runs exactly this (`.github/workflows/conformance.yml`).

## Against another media plane

The media plane must trust a key the suite holds, so give it one:

1. Make a key pair for the suite only (never a production key):

   ```sh
   openssl genpkey -algorithm ed25519 -out cf.pem
   echo "cf-1:$(base64 < cf.pem | tr -d '\n')"                         # CONFORMANCE_SIGNING_KEY
   echo "cf-1:$(openssl pkey -in cf.pem -pubout | base64 | tr -d '\n')" # add to the media plane's MEDIA_TOKEN_PUBLIC_KEYS
   ```

2. Add the public half to the media plane's key ring and note its instance id
   (the issuer tokens must carry).
3. Make the suite's callback server reachable from the media plane. It
   listens on `CONFORMANCE_CALLBACK_HOST:CONFORMANCE_CALLBACK_PORT`
   (default `127.0.0.1:47801`) and tells the media plane to call
   `CONFORMANCE_CALLBACK_BASE` (default `http://127.0.0.1:47801`): set it to
   whatever address the media plane's egress and WHIP ingress can reach (the
   host's LAN address, `host.docker.internal`, a tunnel). Presigned uploads go
   there too (`/bucket/...`).
4. Run:

   ```sh
   CONFORMANCE_CONTROL_URL=http://localhost:4200 \
   CONFORMANCE_WHIP_URL=http://localhost:4600/whip \
   CONFORMANCE_SIGNING_KEY="cf-1:..." \
   CONFORMANCE_ISSUER=<media plane instance id> \
   CONFORMANCE_CALLBACK_BASE=http://<reachable host>:47801 \
   CONFORMANCE_CALLBACK_HOST=0.0.0.0 \
   node conformance/src/run.ts
   ```

`CONFORMANCE_ONLY=tokens,control` runs some groups; `CONFORMANCE_RESULTS=out.json`
writes the results. A media plane whose WHIP is on another listener than its
control API needs `CONFORMANCE_WHIP_URL`.

Run it against your own deployments only, with a key made for the suite, in
a project or room space where test rooms (`cf-…`) are harmless. It creates and
deletes rooms and egress sessions; it never needs a production credential.
