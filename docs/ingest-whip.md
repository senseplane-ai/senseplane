# Publishing with WHIP

Senseplane accepts WebRTC-HTTP Ingestion (WHIP, RFC 9725) for cameras,
encoders and relays. The stream is recorded exactly as sent: **H.264 video
(packetization-mode 1) and, if the source records audio, Opus.** Nothing is
transcoded, so configure the encoder for H.264, a keyframe about every 2 s,
and no more than the instance's maximum resolution (`QUOTA_MAX_RESOLUTION`,
720p by default).

## 1. Create a WHIP source

```bash
curl -s -X POST "$API/v1/sources" -H "Authorization: Bearer $SENSEPLANE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "Garage camera", "type": "whip"}'
```

The response contains `ingest.whip_url` and `ingest.token`. The token is shown
only once and doesn't expire. Keep it like a password.

- Rotate it (the old one stops working and a live publisher is disconnected):
  `POST /v1/sources/{id}/ingest-token`
- Revoke it: `DELETE /v1/sources/{id}/ingest-token`

## 2. Publish

### OBS Studio (30+)

1. Settings → Stream → Service: **WHIP**.
2. Server: the `whip_url`. Bearer Token: the `token`.
3. Settings → Output (Advanced) → Encoder: an **H.264** encoder (x264 or
   hardware), Keyframe Interval **2 s**, Profile **baseline** or **main**,
   B-frames **0**.
4. Settings → Video → Output resolution **1280×720** (or the instance's maximum).
5. Start Streaming. Audio is recorded only if the source has `record_audio`.

### GStreamer

```bash
gst-launch-1.0 videotestsrc is-live=true ! video/x-raw,width=1280,height=720 \
  ! x264enc tune=zerolatency key-int-max=50 bframes=0 ! rtph264pay config-interval=-1 pt=96 \
  ! "application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000" \
  ! whipsink whip-endpoint="$WHIP_URL" auth-token="$WHIP_TOKEN"
```

(`whipsink` needs GStreamer's webrtc plugins: libnice and srtp.)

### An RTSP camera, without re-encoding

The bridge does this for you: create a source with `"type":"rtsp"` and run
the `docker run` command it returns (see [Self-hosting](self-host.md#ip-cameras-and-the-bridge)).
To try the WHIP path by hand, build the bridge's WHIP
client and pipe the camera's own H.264 into it:

```bash
cd bridge && go build -o whip-push ./cmd/whip-push
ffmpeg -rtsp_transport tcp -i rtsp://user:pass@camera/stream -an -c copy -bsf:v dump_extra -f h264 - \
  | WHIP_TOKEN=... ./whip-push -endpoint "$WHIP_URL" -fps 15
```

`-c copy` keeps the camera's stream byte for byte; `dump_extra` repeats
SPS/PPS before keyframes. Set `-fps` to the camera's frame rate.

### go2rtc

go2rtc (v1.9.14) can't publish WHIP: its `publish:` module only supports
RTMP and rejects `webrtc:`/`whip:` URLs ("unsupported scheme"). Use go2rtc to
pull the camera and `whip-push` (above) or the bridge to push it. See
ADR 0034.

### curl (to see the exchange)

```bash
curl -i -X POST "$WHIP_URL" -H "Authorization: Bearer $WHIP_TOKEN" \
  -H "Content-Type: application/sdp" --data-binary @offer.sdp
# 201 Created, Location: /whip/<source>/<session>, body: the SDP answer
curl -X DELETE "https://media.example$LOCATION" -H "Authorization: Bearer $WHIP_TOKEN"
```

## Behaviour

- **One publisher per source.** A new WHIP session (or the browser capture
  page) replaces the previous one.
- **Offers must include candidates** (non-trickle). `PATCH` (trickle ICE, ICE
  restart) answers 405. After a network drop, POST again; the gap shows in the
  playback timeline.
- **Clients that can't send headers** may append `?access_token=<token>` to
  the WHIP URL. Prefer the header: URLs end up in logs.
- **Errors:** 401 bad or revoked token · 409 `source_limit_reached` · 415
  `unsupported_codec` (no H.264) · 429 `quota_exceeded` · 503 the node is
  draining or can't reach the API. A stream above the allowed resolution is
  disconnected with `resolution_not_in_plan` and nothing is recorded.

## Self-hosting

The compose bundle wires it up: the API's `MEDIA_PUBLIC_URL` sets the WHIP
URL base, and the media plane checks each token through the API's callback
(`API_CALLBACK_URL`). `WHIP_CORS_ORIGINS` limits browser origins (default: any, since WHIP
uses bearer tokens, not cookies).
