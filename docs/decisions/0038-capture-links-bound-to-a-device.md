# 38. Capture links bound to a device

Date: 2026-10-17 · Status: accepted

## Context
A capture link (or its QR code) was a reusable credential for 24 hours, and
"newest replaces old" (ADR 0017) meant anyone who saw it could take over the
camera and inject video.

## Decision
- The capture page generates a random device key once and keeps it on the
  device. The first `POST /v1/capture/join` with it binds the link to that
  device; later joins need the same key.
- An unbound link must be first used within **10 minutes** of issue.
- `POST /v1/sources/{id}/capture-link` (owner keys) bumps the source's capture
  epoch, unbinds the device and returns a new link; earlier links stop working.
  The console shows "New capture link" for every camera.
- Join tokens are single-use: the media plane refuses a token it has already
  seen. Clients fetch a fresh token for every connection.
- Every join is audited with the client IP.
- Newest-replaces-old still applies to the bound device, so reconnects work.

## Consequences
A join without `device` (older capture pages) works only during the first
10 minutes of an unbound link and doesn't bind it. Moving a camera to another
phone means creating a new link.
