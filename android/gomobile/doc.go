// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// Package gomobile only holds the dependencies for binding bridge/mobile:
//
//	gomobile bind -target android/arm64,android/amd64 -androidapi 26 \
//	  -javapkg com.senseplane.go -o ../app/libs/senseplane-bridge.aar \
//	  github.com/senseplane-ai/senseplane/bridge/mobile
package gomobile

import _ "github.com/senseplane-ai/senseplane/bridge/mobile"
