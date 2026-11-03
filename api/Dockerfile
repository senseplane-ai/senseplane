# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
# Build from the repo root: docker build -f api/Dockerfile .

# --- FFmpeg for stories and object following (ADR 0070) ---------------------------
# LGPL, shared libraries, and no H.264 encoder: stories copy the recorded video as it is (captions are a
# subtitle track), and following decodes frames to JPEG. It reads fMP4 (H.264, AAC, Opus) and writes fMP4,
# MP4 with mov_text subtitles, and JPEG.
FROM debian:bookworm-slim AS ffmpeg
ARG FFMPEG_VERSION=8.0.3
ARG FFMPEG_SHA256=6136812ea6d4e68bdba27e33c2a94382711cdf4f8602ffef056ff792bd6f9818
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils build-essential nasm pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLO https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz \
 && echo "${FFMPEG_SHA256}  ffmpeg-${FFMPEG_VERSION}.tar.xz" | sha256sum -c - \
 && tar xf ffmpeg-${FFMPEG_VERSION}.tar.xz
WORKDIR /src/ffmpeg-${FFMPEG_VERSION}
# No --enable-gpl / --enable-nonfree, and no video encoder but MJPEG: the result is LGPL 2.1+ and encodes no H.264.
RUN ./configure --prefix=/opt/ffmpeg --enable-shared --disable-static --disable-doc --disable-debug \
      --disable-everything --disable-autodetect --disable-ffplay --enable-ffmpeg --enable-ffprobe \
      --enable-protocol=file,pipe \
      --enable-demuxer=mov,concat,webvtt \
      --enable-muxer=mp4,mov,null,image2pipe,webvtt \
      --enable-encoder=mjpeg,mov_text,webvtt \
      --enable-decoder=h264,aac,opus,webvtt,mov_text \
      --enable-parser=h264,aac,opus \
      --enable-bsf=h264_mp4toannexb,extract_extradata,aac_adtstoasc \
      --enable-filter=null,anull,format,scale,fps \
      --enable-swscale --enable-swresample \
 && make -j"$(nproc)" && make install \
 && /opt/ffmpeg/bin/ffmpeg -hide_banner -version | tee /opt/ffmpeg/VERSION \
 && ! grep -E -- '--enable-(gpl|nonfree)' /opt/ffmpeg/VERSION \
 && ! /opt/ffmpeg/bin/ffmpeg -hide_banner -encoders | grep -E ' (h264|hevc|libx26|libopenh264)' \
 && cp COPYING.LGPLv2.1 /opt/ffmpeg/LICENSE

FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY api/package.json api/
COPY telemetry/package.json telemetry/
RUN pnpm install --filter "@senseplane/api..." --frozen-lockfile
COPY telemetry telemetry
COPY api api
RUN pnpm --filter "@senseplane/api..." build && pnpm --filter @senseplane/api deploy --prod --legacy /out

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.licenses="Apache-2.0 AND LGPL-2.1-or-later"
COPY --from=ffmpeg /opt/ffmpeg /opt/ffmpeg
ENV PATH=/opt/ffmpeg/bin:$PATH LD_LIBRARY_PATH=/opt/ffmpeg/lib FFMPEG_PATH=/opt/ffmpeg/bin/ffmpeg
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 8080
# Telemetry is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (docs/observability.md).
CMD ["node", "--import", "@senseplane/telemetry/register", "dist/server.js"]
