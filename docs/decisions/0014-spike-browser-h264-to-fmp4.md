# 14. Spike: browser H.264 → mediasoup → fMP4 without re-encoding

Date: 2026-10-15 · Status: accepted (spike passed)

## Question
Can H.264 published from a browser through mediasoup be recorded as fMP4
segments of about 6 s with no re-encoding (ADR 0010–0012)?

## Setup
`media/spike/run.ts` (`pnpm --filter @senseplane/media spike 60`):
headless Chrome with a fake camera (1280×720 requested) → `mediasoup-client`
→ mediasoup 3.30 WebRtcTransport (H.264 only) → PlainTransport consumer →
FFmpeg reading an SDP with `-c:v copy` and the HLS muxer in fMP4 mode
(`-hls_time 6 -hls_segment_type fmp4`). A keyframe is requested every 2 s.
Machine: Apple Silicon MacBook, Node 24.11, FFmpeg 8.0.1 (Homebrew).

## Result (60 s run)
| Measure | Value |
|---|---|
| Codec in the file | H.264 Constrained Baseline, 1280×720, 20 fps |
| Stream copy | yes (`Stream #0:0 -> #0:0 (copy)`) |
| Segments | 10, 4.3–8.0 s each (cuts on the next keyframe after 6 s) |
| Recorded vs playable | 60 s recorded → 60.3 s playable, no gaps |
| Time to first producer | ~0.8 s after page load |
| FFmpeg CPU | ≈0% of one core (remux only) |
| Avg segment size | ~190 KB (fake camera, low motion) |

**It works.** The approach for the `segments` egress type is confirmed.

## Findings and follow-ups
- Without `track.contentHint = "detail"`, headless Chrome dropped to
  320×180. The capture page should set it (keep resolution, drop frame rate).
- FFmpeg ignores `q` once its UDP input has stopped; the recorder must stop
  FFmpeg before tearing down the consumer, with a SIGKILL fallback.
- Segment boundaries follow keyframes, so the 2 s keyframe request keeps
  segments within ~6–8 s. Real phones need checking in M1.
- The spike used Homebrew's FFmpeg (a GPL build) as a local dev tool only.
  Production must use an LGPL FFmpeg build, or a small in-process RTP→fMP4
  muxer, which would remove FFmpeg from the recording path entirely. Decide
  in M1.
- Audio (Opus) and real phones (Safari/Chrome on iOS/Android) were not tested;
  both are M1 work.
