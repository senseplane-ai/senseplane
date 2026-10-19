# Roadmap

What the open-source Senseplane does today and what comes next. Each milestone
has a test that says when it is done; results are in [`milestones/`](milestones/).

## Milestones

| | Milestone | Done when |
|---|---|---|
| M0 | **Foundations:** monorepo, licences, CI per layer, compose infrastructure, a tenancy skeleton (accounts, `account_id`, row-level security), `spec/` with the public schemas and the media contract | `docker compose up` works, CI is green, the browser-H.264-to-fMP4 spike has an ADR |
| M1 | **Phone to recording:** browser capture page (`mediasoup-client`), media control API and token auth, `POST /sources`, console QR page with the consent indicator, file-replay publisher | A phone streams, and the last minute plays back within 15 s of being captured |
| M2 | **Recording and playback:** ~6 s segments, an index built from `media.segment.written`, HLS ranges, clips, retention-based deletion (per account and per source), load test with the replay publisher | 24 h with no missing segments; any minute starts playing in under 2 s; a clip survives raw deletion; streams per node benchmarked |
| M3 | **Signal and perception:** analysis feed with masks, motion and audio, object detection and tracking, sound classification, zones, episodes, events, signed webhooks, sensor readings by push | Person events fire within 2 s, with a clip attached, delivered by signed webhook (on fixtures) |
| M4 | **Watches and understanding:** the watch spec, the VLM adapter (any OpenAI-compatible endpoint), `look` and `ask`, memory search, feedback | The package watch catches every delivery in a day of door footage with fewer than 3 false events; fewer than 50 model calls per camera per day; `what_happened` finds the courier |
| M4.5 | **Live demo:** a no-sign-up demo API (temporary account, one phone source, preset watches, live event stream, ask) that a website can embed | A phone streams from a web page, events and answers appear live, and everything is deleted after the session |
| M5 | **MCP and SDK:** 8 tools over stdio and remote (OAuth), TypeScript SDK, quick-start docs | Claude, Cursor and one more client call all 8 tools; spec-drift CI is green |
| M6 | **Grants, privacy, metering:** per-agent grants, privacy masks, audit log, export and deletion, usage records, quotas | A video-only grant gets an error on `listen`; masked regions are black in snapshots and model inputs; revocation within 60 s; usage per account matches a known test load within 1% |
| M7 | **More ingest:** WHIP (done: `whip` sources, per-source tokens with rotation, [WHIP ingest](ingest-whip.md), ADR 0034); RTMP with per-source tokens; MCP Registry listing | OBS and one push camera record for 24 h without gaps |
| Live | **Live view** (ADR 0042, done): watch a camera live in the browser over the media signalling protocol, no transcoding; video grant required, audio only with an audio grant; idle viewers closed; viewer-minutes metered; feature switch, viewer cap and allowance through the quota provider | A viewer sees frames within 2 s; a video-only grant gets no audio; an idle viewer is closed |
| M8 | **Bridge:** RTSP cameras over WHIP, outbound only, with health reports and a Docker image, and the Home Assistant integration for climate sensors (done, ADR 0045); next: pairing codes, ONVIF discovery, remote updates | An ONVIF camera records within 2 min of pairing, with no router changes |

## Planned features

- **Storage:** optional batched uploads (keep ~6 s segments for playback, upload them grouped into ~1-minute objects with a byte-range index) to cut object-store write operations about 10×.
- **Ingest:** SRT; an Android app (camera mode, then relay); push cameras and the bridge pick the camera stream that fits `max_resolution` (substream or ONVIF profile), never transcoding.
- **Privacy:** per-account encryption keys; face and plate redaction before the model.
- **SDKs:** Python SDK.
- **Understanding:** image embeddings; more watch modes (count, duration, first/last, absence).
- **Workflows:** "when this happens, do that", without code. Triggers: a watch firing, any event type (a person, a sound, a reading over a threshold), a camera going offline, or a schedule. Steps: call an HTTP API, send an email, SMS or WhatsApp, post to Slack or Teams, create a Jira or Linear ticket, wake an agent, make a clip, or speak through a camera (with Speak), with conditions, delays and retries between them, and each run logged. The watch's `notify` list becomes the first step. Built-in steps cover the common cases; nodes for n8n, Zapier and Home Assistant automations cover the rest. A step can tell people or systems; it never moves anything physical (see "Never in scope").
- **Multi-camera stories:** one video built from many moments, across cameras, in time order: pick events or time ranges (or a search such as "the courier, 14:00–14:20") and get a single clip with each camera labelled, shareable by signed link and kept like a saved clip. Following one person automatically from camera to camera ("how did they get in, and which rooms did they enter?") needs matching people across cameras by appearance. That is close to identification, so it comes only after a legal review, never with faces, and off by default.
- **Talk-back ("Speak"):** send audio to a camera's speaker. First push-to-talk in live view and to phone cameras (the capture page plays it), then IP cameras through the bridge (ONVIF backchannel first, then vendor APIs; the bridge converts Opus to G.711), and talking to several cameras at once. For agents, a `speak` tool with text-to-speech, also as a watch action. A new **Speak** permission, off by default like Listen, with every use in the audit log; the rules for agents speaking go in [lawful camera use](lawful-use.md) first.
- **Later:** WHEP egress for third-party players (live view itself ships over the signalling protocol, ADR 0042), H.265, public stream URLs, Kubernetes/Helm.

## Never in scope

Face recognition, plate reading, speech transcription without a legal review,
actuation (beyond talk-back through a camera's own speaker) and hardware.
Senseplane does perception, not decisions.
