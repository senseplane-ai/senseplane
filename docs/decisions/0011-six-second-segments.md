# 11. Segments of about 6 seconds

Date: 2026-10-15 · Status: accepted

## Decision
Target segment length is about 6 s, cut at the first keyframe after the target.
That is 3× fewer object-storage writes than 2 s segments (about 14,400 per
camera per day instead of 43,200). Clips are still cut from whole segments.
For WebRTC sources the media plane requests a keyframe about every 2 s so cuts
stay close to the target; RTSP/RTMP cameras keep their own GOP.
