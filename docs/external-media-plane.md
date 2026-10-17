# Run Senseplane against an external media plane

The API reaches the media plane only through the media contract
([`spec/media`](../spec/media/README.md), ADR 0049). Any media plane that
implements it, the bundled `media/` or one running elsewhere, is used the
same way: nothing in the code changes, only these settings on the `api`.

| Setting | Value |
|---|---|
| `MEDIA_CONTROL_URL` | The media plane's control API base (`/control/*` lives under it). `https://` works |
| `MEDIA_SIGNING_KEY` | `kid:base64pem`, the Ed25519 private key the API signs join, control and WHIP tokens with. Add its public half (`kid:base64(SPKI PEM)`) to the media plane's `MEDIA_TOKEN_PUBLIC_KEYS` |
| `MEDIA_ISSUER` | The media plane's instance id (its `MEDIA_INSTANCE_ID`): every token carries it as `iss` |
| `API_CALLBACK_URL` | A base URL of this API the media plane can reach: room events, feed events, upload URLs, frames and WHIP authorize are POSTed to `<this>/internal/media/callbacks`, each with a bearer the API issued. Default `API_PUBLIC_URL` |
| `MEDIA_PUBLIC_URL` | The media plane's public WHIP base, if you use WHIP sources or the bridge (`<this>/whip/<source>`). Unset: WHIP is off |
| `S3_UPLOAD_ENDPOINT` | The bucket URL put in presigned upload URLs. The media plane PUTs every segment to it, so it must reach it: an internet-reachable S3-compatible bucket for a remote media plane. Unset: `S3_ENDPOINT` |

The signalling URL is not a setting: the media plane returns it with every
room (`signal_url`), and the capture page, live view and the feed egress use
what it says.

With Compose, keep everything else and leave out the bundled media service:

```sh
MEDIA_CONTROL_URL=https://media.example.net MEDIA_SIGNING_KEY="sp-1:…" MEDIA_ISSUER=<instance id> \
API_CALLBACK_URL=https://api.example.com MEDIA_PUBLIC_URL=https://whip.example.net \
S3_UPLOAD_ENDPOINT=https://s3.example.net \
  docker compose -f deploy/compose/docker-compose.yml --profile app up -d --scale media=0
```

RustFS stays the default bucket for the bundled media plane, which reaches it
on the Compose network. When `S3_UPLOAD_ENDPOINT` is another store, point
`S3_ENDPOINT`, `S3_BUCKET` and the credentials at the same bucket so playback
reads what was uploaded.

Notes:

- Feed egress join tokens carry `transport: "pipe"`: the media plane's own
  egress leg, whatever that is inside it ([tokens](../spec/media/tokens.md)).
- A local API behind NAT needs `API_CALLBACK_URL` to be reachable from the
  media plane (a public hostname or a tunnel); browsers and phones need to
  reach the media plane's signalling and WebRTC addresses.
- Before relying on a media plane, run the conformance suite against it with
  a key made for the suite ([conformance/README.md](../conformance/README.md)).
