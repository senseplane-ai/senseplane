# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
# Build from the repo root: docker build -f media/Dockerfile .

# --- FFmpeg: LGPL, shared libraries; remux for segments, H.264 decode + MJPEG for frames (ADR 0015) 
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
# No --enable-gpl / --enable-nonfree: the result is LGPL 2.1+.
RUN ./configure --prefix=/opt/ffmpeg --enable-shared --disable-static --disable-doc --disable-debug \
      --disable-everything --disable-autodetect --disable-ffplay --enable-ffmpeg --enable-ffprobe \
      --enable-protocol=file,pipe,udp,rtp \
      --enable-demuxer=sdp,rtp,mov,h264 \
      --enable-muxer=hls,mp4,mov,rtp,null,rawvideo,pcm_f32le,image2pipe \
      --enable-encoder=rawvideo,pcm_f32le,mjpeg \
      --enable-parser=h264,opus,aac \
      --enable-decoder=h264,opus,aac \
      --enable-bsf=h264_mp4toannexb,extract_extradata,aac_adtstoasc \
      --enable-filter=null,anull,aresample,aformat,format,scale,fps,pad,setsar \
      --enable-swscale --enable-swresample \
 && make -j"$(nproc)" && make install \
 && /opt/ffmpeg/bin/ffmpeg -hide_banner -version | tee /opt/ffmpeg/VERSION \
 && ! grep -E -- '--enable-(gpl|nonfree)' /opt/ffmpeg/VERSION \
 && cp COPYING.LGPLv2.1 /opt/ffmpeg/LICENSE

# --- Node build ---------------------------------------------------------------
FROM node:24-bookworm-slim AS build
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY media/package.json media/
COPY telemetry/package.json telemetry/
RUN pnpm install --filter "@senseplane/media..." --frozen-lockfile
COPY telemetry telemetry
COPY media media
RUN pnpm --filter "@senseplane/media..." build && pnpm --filter @senseplane/media deploy --prod --legacy /out

# --- Runtime ------------------------------------------------------------------
FROM node:24-bookworm-slim
LABEL org.opencontainers.image.licenses="Apache-2.0 AND LGPL-2.1-or-later"
COPY --from=ffmpeg /opt/ffmpeg /opt/ffmpeg
ENV PATH=/opt/ffmpeg/bin:$PATH LD_LIBRARY_PATH=/opt/ffmpeg/lib FFMPEG_PATH=/opt/ffmpeg/bin/ffmpeg MEDIA_WORK_DIR=/tmp/senseplane-media
WORKDIR /app
COPY --from=build /out .
COPY fixtures/*.mp4 /app/fixtures/
USER node
EXPOSE 8090 40000/udp 40000/tcp
# Telemetry is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (docs/observability.md).
CMD ["node", "--import", "@senseplane/telemetry/register", "dist/server.js"]
