# 15. Recording uses an LGPL FFmpeg build, loaded dynamically

Date: 2026-10-15 · Status: accepted

## Context
The M0 spike (ADR 0014) recorded with Homebrew's FFmpeg, a GPL build. The
alternative was an in-process RTP→fMP4 muxer with no FFmpeg at all.

## Decision
The `segments` egress runs FFmpeg as a child process from an **LGPL build**
(configured without `--enable-gpl` or `--enable-nonfree`, shared libraries).
It is only used to remux (`-c copy`); no encoder is needed, so no GPL
component (x264, x265) is ever required.

- The media image installs FFmpeg from a pinned LGPL build and records its
  `ffmpeg -version` configuration in the image labels; CI fails if
  `--enable-gpl` or `--enable-nonfree` appears.
- FFmpeg's source offer and licence notice go in `NOTICE` and the image.
- Development machines may use any local FFmpeg via `FFMPEG_PATH`.

## Consequences
FFmpeg stays an external process, so a crash loses at most the open segment.
The recorder must stop FFmpeg before the RTP stream ends (spike finding).
