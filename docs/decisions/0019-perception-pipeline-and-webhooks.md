# 19. Perception pipeline, events and webhooks (M3)

Date: 2026-10-16 · Status: accepted · NATS transport superseded by ADR 0051 (Valkey); masks are applied in the API since ADR 0049

## Analysis feed (media)
- Each live source gets one extra decoder (FFmpeg, LGPL): 5 fps, scaled and
  letterboxed into a fixed **640×360 rgb24** box, plus 1 s of 16 kHz mono
  `f32le` audio when the source has audio. Recording stays a separate remux.
- **Privacy masks are applied in the media plane before a frame is
  published**, so no model, snapshot or log downstream ever sees the masked
  pixels. Masks and zones come from NATS KV `sources`, written by the API on
  `PATCH /v1/sources/{id}`; changes apply within a second.
- Frames and audio go out on core NATS (`frames.*`, `audio.*`): ephemeral, not
  persisted. The brain processes the latest frame per source and drops older
  ones if it falls behind, so latency stays bounded instead of growing.

## Brain
- Signal: motion on a 160×90 grey frame with a running-average background;
  a change over 60% of the frame is a lighting change (background reset, no
  motion). Loudness in dBFS.
- Detection: YOLOX-s (ONNX, Apache 2.0) when there is motion, an active track,
  or every 5th frame; COCO classes mapped to person / vehicle / animal.
- Tracking: ByteTrack-style two-stage IoU association with constant velocity;
  confirmed after 2 hits; stationary after 10 s of < 2% movement (no new events).
- Events: one per label per episode once the track's best score reaches
  0.5 (person, vehicle) or 0.6 (animal: crouching people and bags score ~0.5
  as "dog"). `occurred_at` is when the track was first seen. An episode ends
  5 s after its last active track (`brain.episode.closed`).
- Sound: YAMNet (TFLite, Apache 2.0) per 1 s chunk; classes crying,
  glass_break, alarm, dog (speech_present is computed but not an event).
  Scores only; nothing is transcribed. 30 s cooldown per class.
- Models are downloaded from pinned URLs and verified by SHA-256
  (`brain/src/senseplane_brain/models.py`), never committed.

## API
- Events from `brain.event` (JetStream, durable, idempotent on `event_key`),
  with the snapshot stored at `snapshots/{account}/{source}/…`.
- The event clip ([start − 5 s, end + 10 s], ≤ 1 h) is cut 30 s after the event
  (or 15 s after the episode ends); until then `clip_url` plays the same window
  from raw segments, so webhooks always carry a playable clip link.
- Webhooks: `Senseplane-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t.body)>`,
  retries at 5 s, 15 s, 30 s, 1 m, 2 m, 5 m, 10 m, 30 m, 1 h, 2 h, then every 4 h,
  until 24 h after creation; every attempt is in the delivery log. New events
  wake the delivery worker immediately. In production, webhook URLs must be
  https and not private/loopback addresses (basic SSRF guard).
- `sensor.threshold` fires on the crossing (previous reading inside the
  threshold, new one outside), not on every reading past it.
