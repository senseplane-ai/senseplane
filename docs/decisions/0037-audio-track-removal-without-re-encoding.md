# 37. Removing the audio track without re-encoding

Date: 2026-10-17 · Status: accepted

## Context
With `record_audio` on, recordings keep video and audio in the same fMP4
segments. An agent with a video grant but no audio grant must not hear the
audio. Re-encoding is not allowed in the media path.

## Decision
Playback for such scopes is streamed through the API (never redirected to
storage) and rewritten box by box:
- the init segment loses the audio `trak` and its `trex`;
- each media segment loses the audio `traf` boxes, the `mdat` is rebuilt from
  the remaining samples' bytes only, and every `trun` data offset is rewritten
  (fragments become default-base-is-moof); `sidx` is dropped.

Sample bytes are copied unchanged; the audio bytes are gone, not just
unreferenced. Tested against FFmpeg HLS fMP4 output: the result has one video
stream, decodes without errors and keeps every frame.

## Consequences
Video-only playback of audio recordings costs API bandwidth and a little CPU.
Recordings without audio are untouched and still redirect to storage.
