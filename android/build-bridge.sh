#!/bin/sh
# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
#
# Builds the bridge for the app (app/libs/senseplane-bridge.aar) with gomobile.
# Needs Go, gomobile (go install golang.org/x/mobile/cmd/gomobile@latest) and
# the Android NDK. -checklinkname=0: Pion's Android interface lookup
# (github.com/wlynxg/anet) reaches into the net package, which newer Go only
# allows with this flag.
set -eu
cd "$(dirname "$0")/gomobile"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)}"
PATH="$PATH:$(go env GOPATH)/bin"
gomobile bind -target android/arm64,android/amd64 -androidapi 26 -ldflags=-checklinkname=0 \
  -javapkg com.senseplane.go -o ../app/libs/senseplane-bridge.aar \
  github.com/senseplane-ai/senseplane/bridge/mobile
