# 21. Live demo: retention and abuse limits

Date: 2026-10-16 · Status: accepted

A website can embed a real demo with no sign-up
(`POST /v1/demo/sessions`, spec/openapi.yaml, tag `demo`). It is the only
unauthenticated way to create anything, so it is boxed in on every axis.
All numbers are environment variables on the API.

| Limit | Default | Env |
|---|---|---|
| Session length | 10 min, then the camera is disconnected and the stream ends | `DEMO_SESSION_MINUTES` |
| Data kept after the session ends | **1 hour**, then the temporary account and everything under it (rows, segments, clips, snapshots, KV entries) is deleted | `DEMO_DELETE_AFTER_MINUTES` |
| Senses | Video only (no microphone is requested; `record_audio` is off) | — |
| Sessions per IP per day | 5 | `DEMO_SESSIONS_PER_IP_DAY` |
| Concurrent demo sessions | 20 (protects the media node) | `DEMO_MAX_CONCURRENT` |
| Model calls per session | 20 (watch checks + live "ask"); after that the session's watches are paused and live ask is refused, memory answers still work | `DEMO_SESSION_VLM_CALLS` |
| Model calls per day, all demos | 2,000; when spent, new sessions are refused until the next UTC day | `DEMO_DAILY_VLM_CALLS` |
| Browser origins (CORS) | none in production (the deployment sets them); `http://127.0.0.1:3002` in development | `DEMO_ORIGINS` |

Details:
- IPs are never stored: only `sha256(ip + daily salt)`, and the salt rotates
  every UTC day, so a hash can't be linked across days.
- Each session gets a fresh temporary account (`kind = demo`) with one browser
  source and two pre-compiled watches (no model call to compile): "Tell me if
  a package is left at the door" (person arrives then leaves, then the model
  checks) and "Tell me when someone comes to the door" (no model check).
- The session token is a random 32-byte bearer token, stored hashed, valid only
  for that session's demo endpoints. The live stream is SSE over `fetch` with
  the token in the `Authorization` header, never in the URL.
- The capture link points at the website's demo page (`DEMO_CAPTURE_URL`), so a
  phone captures inside the same design; `POST /v1/capture/join` accepts the
  demo origins too.
