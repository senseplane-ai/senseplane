# 22. Maximum recording resolution per account, enforced at the source

Date: 2026-10-16 · Status: accepted

## Context
Recording cost (storage, bandwidth) grows with resolution, so a deployment may
want to limit it per account. The media plane never transcodes (ADRs 0012 and
0014: H.264 copied into fMP4), so the limit cannot be applied by re-encoding.

## Decision
1. **Account → source.** The quota provider (`Quota.maxResolution`) gives each
   account `720p` or `1080p`. The default is `720p`, set per instance with
   `QUOTA_MAX_RESOLUTION`. Every Source shows it as read-only
   `max_resolution`.
2. **Capture asks for the right size.** `POST /v1/capture/join` returns
   `max_resolution`. The capture page and the demo page request 1280×720
   (1920×1080 when allowed) from `getUserMedia` and cap H.264 at 1.5 Mbps
   (720p) or 3 Mbps (1080p).
3. **The media plane refuses, never transcodes.** The join token carries
   `grants.maxResolution` (a Senseplane extension grant; clients never read
   it). When the recorder's first init segment exists, the media plane reads
   its width and height with ffprobe. If the long edge or the short edge is
   above the limit (1280/720 or 1920/1080; portrait counts the same as
   landscape), nothing is uploaded, the session ends with `roomClosed` reason
   `resolution_not_in_plan`, and the source goes offline with that reason.
   The public error code `resolution_not_in_plan` is in `error.json`.
4. **Later ingest:** push cameras and the bridge choose the camera stream
   that fits (a substream or an ONVIF profile). Still no transcoding.

## Consequences
- Detection takes one probe (~1–2 s after the first keyframe); the analysis
  feed may see those first frames, but nothing is stored.
- A browser that ignores the requested size (rare) is refused instead of
  silently recorded larger.
- Usage records count camera-minutes per resolution (M6).
