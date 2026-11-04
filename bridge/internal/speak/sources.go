// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

package speak

import (
	"net/url"
	"strings"

	"github.com/AlexxIT/go2rtc/pkg/core"
	"github.com/AlexxIT/go2rtc/pkg/doorbird"
	"github.com/AlexxIT/go2rtc/pkg/dvrip"
	"github.com/AlexxIT/go2rtc/pkg/multitrans"
	"github.com/AlexxIT/go2rtc/pkg/ring"
	"github.com/AlexxIT/go2rtc/pkg/roborock"
	"github.com/AlexxIT/go2rtc/pkg/tapo"
	"github.com/AlexxIT/go2rtc/pkg/tuya"
	"github.com/AlexxIT/go2rtc/pkg/wyze"

	"github.com/senseplane-ai/senseplane/bridge/internal/third_party/go2rtc/isapi"
)

// source is one of go2rtc's two-way audio sources, by URL scheme (ADR 0075).
type source struct {
	dial func(url string) (core.Producer, error)
	// cloud: the URL carries an account's tokens and the audio goes through the vendor's cloud.
	cloud bool
	// needsRecv: Start refuses a connection that receives nothing (tuya), so the camera's own audio
	// is taken too, and dropped.
	needsRecv bool
}

func producer[T core.Producer](dial func(string) (T, error)) func(string) (core.Producer, error) {
	return func(u string) (core.Producer, error) {
		p, err := dial(u)
		if err != nil {
			return nil, err
		}
		return p, nil
	}
}

var sources = map[string]source{
	"tapo":       {dial: producer(tapo.Dial)},
	"vigi":       {dial: producer(tapo.Dial)},
	"isapi":      {dial: producer(isapi.Dial)},
	"dvrip":      {dial: dialDVRIP},
	"doorbird":   {dial: producer(doorbird.Dial)},
	"multitrans": {dial: multitrans.Dial},
	"ring":       {dial: producer(ring.Dial), cloud: true},
	"roborock":   {dial: producer(roborock.Dial), cloud: true},
	"tuya":       {dial: tuya.Dial, cloud: true, needsRecv: true},
	"wyze":       {dial: producer(wyze.NewProducer), cloud: true},
}

// dialDVRIP opens a DVR-IP camera's talk session: without backchannel=1 it would set up video.
func dialDVRIP(raw string) (core.Producer, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errNotURL
	}
	q := u.Query()
	q.Set("backchannel", "1")
	u.RawQuery = q.Encode()
	return dvrip.Dial(u.String())
}

// Scheme is a talk-back URL's scheme, lower case ("exec" for exec:...).
func Scheme(raw string) string {
	s, _, ok := strings.Cut(raw, ":")
	if !ok {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(s))
}

func isRTSP(raw string) bool {
	s := Scheme(raw)
	return s == "rtsp" || s == "rtsps"
}

// Known says whether the box can talk through a URL of this scheme: rtsp, exec or one of go2rtc's sources.
func Known(raw string) bool {
	s := Scheme(raw)
	_, ok := sources[s]
	return ok || s == "rtsp" || s == "rtsps" || s == "exec"
}

// IsExec: the URL runs a command on the box. Only the box's own flags may name one, never the API.
func IsExec(raw string) bool { return Scheme(raw) == "exec" }

// IsCloud: the URL carries a cloud account's tokens (ring, roborock, tuya, wyze).
func IsCloud(raw string) bool { return sources[Scheme(raw)].cloud }

// Schemes are the go2rtc source schemes the box takes, besides rtsp and exec.
func Schemes() []string {
	out := make([]string, 0, len(sources))
	for s := range sources {
		out = append(out, s)
	}
	return out
}
